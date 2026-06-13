// Real-time notifications over socket.io. The laundromat app connects globally and
// listens for 'new_order', filtering by laundromat_id, so a global emit is sufficient.
function notifyNewOrder(io, order) {
  if (io && order && order.laundromat_id) {
    io.emit('new_order', { id: order.id, laundromat_id: order.laundromat_id, order_number: order.order_number });
  }
}
module.exports = { notifyNewOrder };
