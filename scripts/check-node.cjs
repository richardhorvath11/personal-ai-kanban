// Fails fast with a clear message on Node versions that can't run .ts files natively.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\nPersonal AI Kanban needs Node 22.18 or newer (you have ${process.versions.node}).\n` +
    `It runs TypeScript directly and uses the built-in node:sqlite.\n` +
    `Fix: install Node 24 LTS (e.g. \`nvm install 24 && nvm use 24\`, or https://nodejs.org), then rerun.\n`);
  process.exit(1);
}
