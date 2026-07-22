require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const cron = require('node-cron');
const { connectDB } = require('./utils/db');

// Import routes
const authRoutes = require('./services/auth/auth.routes');
const laundromatRoutes = require('./services/laundromats/laundromat.routes');
const orderRoutes = require('./services/orders/order.routes');
const paymentRoutes = require('./services/payments/payment.routes');
const commissionRoutes = require('./services/commission/commission.routes');
const adminRoutes = require('./services/admin/admin.routes');
const trackingRoutes = require('./services/tracking/tracking.routes');
const {
  servicesRouter, scheduleRouter, supportRouter, usersRouter, reviewsRouter,
} = require('./services/support/misc.routes');

const app = express();
const server = http.createServer(app);

// Trust Railway's proxy so req.ip / rate-limit / secure cookies work correctly
app.set('trust proxy', 1);

// Socket.io setup
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
app.set('io', io);
io.on('connection', (socket) => {
  socket.on('join_order', (orderId) => socket.join(`order_${orderId}`));
  socket.on('leave_order', (orderId) => socket.leave(`order_${orderId}`));
  socket.on('driver_location', ({ orderId, latitude, longitude }) =>
    io.to(`order_${orderId}`).emit('location_update', { latitude, longitude, ts: Date.now() }));
});

// Security & middleware
app.use(helmet({ crossOriginEmbedderPolicy: false, contentSecurityPolicy: false }));
const origins = process.env.NODE_ENV === 'production'
  ? (process.env.ALLOWED_ORIGINS || '*').split(',').map((o) => o.trim())
  : '*';
app.use(cors({
  origin: origins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(morgan('dev'));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests' },
}));

// Health checks
app.get('/', (req, res) => res.json({ status: 'ok', app: 'Smart-Safi API', version: '2.0.0' }));
app.get('/health', (req, res) => res.json({
  status: 'ok', app: 'Smart-Safi API', version: '2.0.0', ts: new Date().toISOString(),
}));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRouter);
app.use('/api/services', servicesRouter);
app.use('/api/schedule', scheduleRouter);
app.use('/api/laundromats', laundromatRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/support', supportRouter);
app.use('/api/earnings', commissionRoutes);
app.use('/api/reviews', reviewsRouter);
app.use('/api/admin', adminRoutes);

// Error handlers
app.use((err, req, res, next) => {
  console.error('Unhandled:', err.message);
  const dev = process.env.NODE_ENV === 'development';
  res.status(err.status || 500).json({
    success: false,
    message: dev ? err.message : 'An unexpected error occurred',
  });
});
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// ── Cron: generate monthly admin-fee invoices on the 1st at 01:00 ──
cron.schedule('0 1 1 * *', async () => {
  const { generateMonthlyAdminFees } = require('./services/commission/commission.service');
  const now = new Date(),
    prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  try {
    const n = await generateMonthlyAdminFees(period);
    console.log(`[CRON] Generated ${n} admin fee invoices for ${period}`);
  } catch (e) {
    console.error('[CRON] Admin fee gen failed:', e.message);
  }
});

// ── Cron: refresh schedule slots daily at midnight ──
cron.schedule('0 0 * * *', async () => {
  const { query } = require('./utils/db');
  const times = ['08:00', '09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00'];
  try {
    for (let i = 1; i <= 14; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      if (d.getDay() === 0) continue;
      const ds = d.toISOString().split('T')[0];
      for (const t of times) {
        await query(
          "INSERT INTO schedule_slots(slot_date,slot_time,slot_type,max_capacity) VALUES($1,$2,'pickup',8),($1,$2,'delivery',8) ON CONFLICT (slot_date,slot_time,slot_type) DO NOTHING",
          [ds, t]
        );
      }
    }
    console.log('[CRON] Slots refreshed');
  } catch (e) {
    console.error('[CRON] Slot refresh failed:', e.message);
  }
});

// ── Start server ──
// ✅ ONLY ONE PORT DECLARATION – using Railway's PORT env or fallback to 5000
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

async function start() {
  try {
    await connectDB();
    server.listen(PORT, HOST, () =>
      console.log(`✅ Smart-Safi API running on ${HOST}:${PORT}`));
  } catch (e) {
    console.error('Failed to start:', e.message);
    process.exit(1);
  }
}
start();

// Graceful shutdown – respond cleanly to Railway's SIGTERM
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});