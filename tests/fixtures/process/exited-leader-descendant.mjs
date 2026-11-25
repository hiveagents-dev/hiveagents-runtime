// Same-group synthetic descendant: inherited stdio outlives its leader.
process.on('SIGTERM', () => {});
process.send?.('ready');
process.disconnect?.();
setInterval(() => {}, 1_000);
