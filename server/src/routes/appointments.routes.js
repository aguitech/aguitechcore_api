import { Router } from 'express';
import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { audit, labelOf } from '../lib/audit.js';
import { notify } from '../lib/notify.js';

const router = Router();

// ====== PUBLIC ROUTES (no auth) — used by the landing page form ======
// Mounted before requireAuth so anonymous visitors can request a slot.
router.get('/public/availability', async (req, res, next) => {
  try {
    const { date, assignee } = req.query;
    if (!date) return res.status(400).json({ msg: 'Fecha requerida (YYYY-MM-DD)' });
    const dayStart = new Date(`${date}T00:00:00.000`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const filter = { startsAt: { $gte: dayStart, $lt: dayEnd }, status: { $in: ['scheduled', 'confirmed'] } };
    if (assignee && mongoose.isValidObjectId(assignee)) filter.assignedTo = assignee;
    const existing = await Appointment.find(filter).select('startsAt endsAt').lean();
    res.json({
      date,
      dayStart: dayStart.toISOString(),
      dayEnd: dayEnd.toISOString(),
      bookedSlots: existing.map((a) => ({
        startsAt: a.startsAt,
        endsAt: a.endsAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/appointments/public/staff — list staff available for booking
router.get('/public/staff', async (_req, res, next) => {
  try {
    const staff = await User.find({ role: { $in: ['admin', 'member'] }, active: { $ne: false } })
      .select('name email role')
      .sort({ name: 1 })
      .lean();
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

// POST /api/appointments/public — book a new appointment (no auth)
router.post('/public', async (req, res, next) => {
  try {
    const { customerName, customerEmail, customerPhone, assignedTo, startsAt, endsAt, subject, description, location } = req.body || {};
    if (!customerName || !customerName.trim()) return res.status(400).json({ msg: 'Nombre requerido' });
    if (!subject || !subject.trim()) return res.status(400).json({ msg: 'Asunto requerido' });
    if (!startsAt || !endsAt) return res.status(400).json({ msg: 'Horario requerido' });
    const s = new Date(startsAt);
    const e = new Date(endsAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ msg: 'Horario inválido' });
    if (e <= s) return res.status(400).json({ msg: 'La hora de fin debe ser posterior' });
    if (s < new Date(Date.now() - 5 * 60 * 1000)) return res.status(400).json({ msg: 'No puedes agendar en el pasado' });

    let assigneeDoc = null;
    if (assignedTo) {
      if (!mongoose.isValidObjectId(assignedTo)) return res.status(400).json({ msg: 'Asignado inválido' });
      assigneeDoc = await User.findById(assignedTo).select('name email role active');
      if (!assigneeDoc) return res.status(400).json({ msg: 'Asignado no existe' });
      if (assigneeDoc.active === false) return res.status(400).json({ msg: 'Ese miembro no está disponible' });
    }

    // Overlap check — refuse if a confirmed/scheduled appointment overlaps
    const overlap = await Appointment.findOne({
      assignedTo: assigneeDoc?._id || null,
      status: { $in: ['scheduled', 'confirmed'] },
      $and: [
        { startsAt: { $lt: e } },
        { endsAt: { $gt: s } },
      ],
    });
    if (overlap) {
      return res.status(409).json({ msg: 'Ese horario ya está ocupado. Por favor elige otro.' });
    }

    const appt = await Appointment.create({
      customerName: customerName.trim(),
      customerEmail: (customerEmail || '').trim().toLowerCase(),
      customerPhone: (customerPhone || '').trim(),
      customerUser: null,
      assignedTo: assigneeDoc?._id || null,
      assignedToName: assigneeDoc?.name || '',
      startsAt: s,
      endsAt: e,
      subject: subject.trim(),
      description: (description || '').trim(),
      location: (location || '').trim(),
      status: 'scheduled',
      source: 'landing',
      ip: req.ip || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '',
      userAgent: (req.headers?.['user-agent'] || '').slice(0, 240),
    });

    // Notify the assigned staff member
    if (assigneeDoc) {
      const when = s.toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'short' });
      notify({
        recipient: assigneeDoc._id,
        type: 'appointment.created',
        title: `📅 Nueva cita: ${appt.customerName}`,
        body: `${appt.subject} — ${when}`,
        link: '/appointments',
        sourceType: 'Appointment',
        sourceId: String(appt._id),
        meta: { customerName: appt.customerName, startsAt: appt.startsAt },
        actor: null,
        actorName: appt.customerName,
      });
    }

    // Audit
    audit({
      req,
      actor: { _id: appt._id, name: appt.customerName, role: 'public' },
      action: 'appointment.create',
      category: 'appointment',
      targetType: 'Appointment',
      targetId: appt._id,
      targetLabel: `${appt.customerName} → ${assigneeDoc?.name || 'sin asignar'} · ${appt.subject}`,
      meta: { source: 'landing' },
    });

    res.status(201).json(appt);
  } catch (err) {
    next(err);
  }
});

// ====== AUTHENTICATED ROUTES (admin / members) ======
router.use(requireAuth);

// POST /api/appointments — create an appointment manually (admin/staff).
// Mirrors the public endpoint but:
//   - requires auth (req.user available)
//   - allows linking customerUser to a registered user by email
//   - sets source: 'manual'
//   - audit actor is the logged-in admin
//   - notifies the assigned staff member
router.post('/', async (req, res, next) => {
  try {
    const { customerName, customerEmail, customerPhone, assignedTo, startsAt, endsAt, subject, description, location, customerUser } = req.body || {};
    if (!customerName || !customerName.trim()) return res.status(400).json({ msg: 'Nombre requerido' });
    if (!subject || !subject.trim()) return res.status(400).json({ msg: 'Asunto requerido' });
    if (!startsAt || !endsAt) return res.status(400).json({ msg: 'Horario requerido' });
    const s = new Date(startsAt);
    const e = new Date(endsAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ msg: 'Horario inválido' });
    if (e <= s) return res.status(400).json({ msg: 'La hora de fin debe ser posterior' });

    let assigneeDoc = null;
    if (assignedTo) {
      if (!mongoose.isValidObjectId(assignedTo)) return res.status(400).json({ msg: 'Asignado inválido' });
      assigneeDoc = await User.findById(assignedTo).select('name email role active');
      if (!assigneeDoc) return res.status(400).json({ msg: 'Asignado no existe' });
      if (assigneeDoc.active === false) return res.status(400).json({ msg: 'Ese miembro no está disponible' });
    }

    // Optional: link the appointment to a registered user (if email matches).
    let linkedUserId = null;
    if (customerUser && mongoose.isValidObjectId(customerUser)) {
      linkedUserId = customerUser;
    } else if (customerEmail && customerEmail.trim()) {
      const u = await User.findOne({ email: customerEmail.trim().toLowerCase() }).select('_id');
      if (u) linkedUserId = u._id;
    }

    // Overlap check (same logic as public route).
    const overlap = await Appointment.findOne({
      assignedTo: assigneeDoc?._id || null,
      status: { $in: ['scheduled', 'confirmed'] },
      $and: [
        { startsAt: { $lt: e } },
        { endsAt: { $gt: s } },
      ],
    });
    if (overlap) {
      return res.status(409).json({ msg: 'Ese horario ya está ocupado. Por favor elige otro.' });
    }

    const appt = await Appointment.create({
      customerName: customerName.trim(),
      customerEmail: (customerEmail || '').trim().toLowerCase(),
      customerPhone: (customerPhone || '').trim(),
      customerUser: linkedUserId,
      assignedTo: assigneeDoc?._id || null,
      assignedToName: assigneeDoc?.name || '',
      startsAt: s,
      endsAt: e,
      subject: subject.trim(),
      description: (description || '').trim(),
      location: (location || '').trim(),
      status: 'scheduled',
      source: 'manual',
    });

    // Notify the assigned staff member.
    if (assigneeDoc && String(assigneeDoc._id) !== String(req.user._id)) {
      const when = s.toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'short' });
      notify({
        recipient: assigneeDoc._id,
        type: 'appointment.created',
        title: `📅 Nueva cita: ${appt.customerName}`,
        body: `${appt.subject} — ${when}`,
        link: '/appointments',
        sourceType: 'Appointment',
        sourceId: String(appt._id),
        meta: { customerName: appt.customerName, startsAt: appt.startsAt },
        actor: req.user._id,
        actorName: req.user.name,
      });
    }

    // If customer is a registered user, notify them too.
    if (linkedUserId && String(linkedUserId) !== String(req.user._id)) {
      notify({
        recipient: linkedUserId,
        type: 'appointment.created',
        title: `📅 Tienes una cita: ${appt.subject}`,
        body: `${new Date(appt.startsAt).toLocaleString('es-MX')}`,
        link: '/my-appointments',
        sourceType: 'Appointment',
        sourceId: String(appt._id),
      });
    }

    // Audit.
    audit({
      req,
      action: 'appointment.create',
      category: 'appointment',
      targetType: 'Appointment',
      targetId: appt._id,
      targetLabel: `${appt.customerName} → ${assigneeDoc?.name || 'sin asignar'} · ${appt.subject}`,
      meta: { source: 'manual' },
    });

    const populated = await Appointment.findById(appt._id)
      .populate('assignedTo', 'name email role')
      .populate('customerUser', 'name email')
      .lean();

    res.status(201).json(populated);
  } catch (err) { next(err); }
});

// GET /api/appointments — list with filters
router.get('/', async (req, res, next) => {
  try {
    const { status, assignedTo, from, to, mine } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (mine === 'true') filter.assignedTo = req.user._id;
    if (from || to) {
      filter.startsAt = {};
      if (from) filter.startsAt.$gte = new Date(from);
      if (to) filter.startsAt.$lte = new Date(to);
    }
    // Non-admins only see their own + ones assigned to them + unassigned
    if (req.user.role !== 'admin') {
      filter.$or = [
        { assignedTo: req.user._id },
        { customerUser: req.user._id },
        { assignedTo: null },
      ];
    }
    const items = await Appointment.find(filter)
      .sort({ startsAt: 1 })
      .populate('assignedTo', 'name email role')
      .populate('customerUser', 'name email')
      .lean();
    res.json(items);
  } catch (err) {
    next(err);
  }
});

// GET /api/appointments/:id — single
router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ msg: 'ID inválido' });
    const appt = await Appointment.findById(req.params.id)
      .populate('assignedTo', 'name email role')
      .populate('customerUser', 'name email')
      .lean();
    if (!appt) return res.status(404).json({ msg: 'Cita no encontrada' });
    if (req.user.role !== 'admin') {
      const isMine = String(appt.assignedTo?._id || '') === String(req.user._id);
      const isMyBooking = String(appt.customerUser?._id || '') === String(req.user._id);
      if (!isMine && !isMyBooking && appt.assignedTo) {
        return res.status(403).json({ msg: 'Sin permiso para ver esta cita' });
      }
    }
    res.json(appt);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/appointments/:id — staff/admin can update status, notes, reschedule
router.patch('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ msg: 'ID inválido' });
    const appt = await Appointment.findById(req.params.id);
    if (!appt) return res.status(404).json({ msg: 'Cita no encontrada' });
    const isAdmin = req.user.role === 'admin';
    const isAssigned = String(appt.assignedTo || '') === String(req.user._id);
    if (!isAdmin && !isAssigned) return res.status(403).json({ msg: 'Sin permiso para modificar esta cita' });

    const { status, staffNotes, startsAt, endsAt, subject, location, assignedTo } = req.body || {};
    const before = { status: appt.status, startsAt: appt.startsAt, endsAt: appt.endsAt, assignedTo: appt.assignedTo };

    if (status !== undefined) {
      if (!['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'].includes(status)) {
        return res.status(400).json({ msg: 'Estado inválido' });
      }
      appt.status = status;
    }
    if (staffNotes !== undefined) appt.staffNotes = String(staffNotes).slice(0, 2000);
    if (subject !== undefined) appt.subject = String(subject).trim().slice(0, 200);
    if (location !== undefined) appt.location = String(location).trim().slice(0, 200);
    if (startsAt) appt.startsAt = new Date(startsAt);
    if (endsAt) appt.endsAt = new Date(endsAt);
    if (assignedTo !== undefined) {
      if (assignedTo === null || assignedTo === '') {
        appt.assignedTo = null;
        appt.assignedToName = '';
      } else {
        if (!mongoose.isValidObjectId(assignedTo)) return res.status(400).json({ msg: 'Asignado inválido' });
        const u = await User.findById(assignedTo).select('name');
        if (!u) return res.status(400).json({ msg: 'Asignado no existe' });
        appt.assignedTo = u._id;
        appt.assignedToName = u.name;
      }
    }
    await appt.save();

    audit({
      req,
      action: appt.status === 'cancelled' ? 'appointment.cancel' : 'appointment.update',
      category: 'appointment',
      targetType: 'Appointment',
      targetId: appt._id,
      targetLabel: `${appt.customerName} · ${appt.subject}`,
      meta: { before, after: { status: appt.status, startsAt: appt.startsAt, endsAt: appt.endsAt, assignedTo: appt.assignedTo } },
      severity: appt.status === 'cancelled' ? 'warning' : 'info',
    });

    // If status changed, notify the customer if they have a user account.
    // Title uses a centralized Spanish label so we never see "Cita completed"
    // in the bell — status keys are english internally, human copy is Spanish.
    const APPT_TITLE = {
      scheduled: '✅ Cita agendada',
      confirmed: '✅ Cita confirmada',
      completed: '✔ Cita completada',
      no_show:   '⚠ Cita marcada como no asistida',
    };
    if (appt.customerUser && appt.status !== before.status) {
      notify({
        recipient: appt.customerUser,
        type: appt.status === 'cancelled' ? 'appointment.cancelled' : 'appointment.created',
        title: appt.status === 'cancelled'
          ? `❌ Cita cancelada: ${appt.subject}`
          : `${APPT_TITLE[appt.status] || `✅ Cita ${appt.status}`}: ${appt.subject}`,
        body: `${new Date(appt.startsAt).toLocaleString('es-MX')}`,
        link: '/my-appointments',
        sourceType: 'Appointment',
        sourceId: String(appt._id),
      });
    }

    const populated = await Appointment.findById(appt._id)
      .populate('assignedTo', 'name email role')
      .populate('customerUser', 'name email')
      .lean();
    res.json(populated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/appointments/:id — admin only
router.delete('/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ msg: 'Solo administradores pueden eliminar citas' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ msg: 'ID inválido' });
    const appt = await Appointment.findByIdAndDelete(req.params.id).lean();
    if (!appt) return res.status(404).json({ msg: 'Cita no encontrada' });
    audit({
      req,
      action: 'appointment.cancel',
      category: 'appointment',
      targetType: 'Appointment',
      targetId: appt._id,
      targetLabel: `${appt.customerName} · ${appt.subject}`,
      severity: 'warning',
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
