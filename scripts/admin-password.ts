import { hashPassword } from '../src/password.js';

if (process.stdin.isTTY) console.error('Pipe a password from stdin to avoid putting it in command arguments or shell history.');
let password = '';
for await (const chunk of process.stdin) password += chunk;
console.log(await hashPassword(password.replace(/\r?\n$/, '')));
