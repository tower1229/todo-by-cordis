process.send({ ready: true });
process.on("message", () => {
  while (true) {}
});
