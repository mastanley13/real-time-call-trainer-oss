#!/usr/bin/env node
// Prints a random JWT_SECRET (and CRON_SECRET) for your .env file.
const crypto = require("crypto");

console.log("# Paste into .env");
console.log(`JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`);
console.log(`CRON_SECRET=${crypto.randomBytes(32).toString("hex")}`);
