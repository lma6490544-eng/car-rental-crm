// Register before the first connection. pg-pool can resolve end() before its
// clients finish disconnecting; DROP DATABASE must wait for those events too.
function trackPoolDisconnects(pool) {
  const disconnected = [];
  pool.on('connect', (client) => {
    disconnected.push(new Promise((resolve) => client.once('end', resolve)));
  });
  let closing;
  return () => {
    closing ??= (async () => {
      await pool.end();
      await Promise.all(disconnected);
    })();
    return closing;
  };
}
module.exports = { trackPoolDisconnects };
