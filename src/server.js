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

// ... import your routes ...

const app = express();
const server = http.createServer(app);

// Trust proxy, middleware, routes, etc. (keep as you have them)
// ...

// ── Health endpoints ──
app.get('/', (req, res) => res.json({ status: 'ok', app: 'Smart-Safi API', version: '2.0.0' }));
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Smart-Safi API', version: '2.0.0' }));

// ... mount your routes ...

// ── Error handlers ──
app.use((err, req, res, next) => { /* ... */ });
app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));

// ── Cron jobs ──
// ... (keep as you have them)

// ── Start server using the PORT from environment ──
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

async function start() {
  try {
    await connectDB();
    server.listen(PORT, HOST, () => {
      console.log(`✅ Smart-Safi API running on ${HOST}:${PORT}`);
    });
  } catch (e) {
    console.error('Failed to start:', e.message);
    process.exit(1);
  }
}
start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => process.exit(0));
});
console.log('PORT env:', process.env.PORT);
const PORT = process.env.PORT || 5000;