// A child that deliberately ignores graceful shutdown; the adapter must kill
// its process group after the timeout and keep the lock until it exits.
console.log(`maintenance-probe-pid:${process.pid}`);
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
