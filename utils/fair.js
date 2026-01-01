const crypto = require('crypto');
exports.generateRound = () => {
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
  return {serverSeed, hash};
};
exports.calculateWin = (serverSeed, clientSeed, edge = 0.05) => {
  const hmac = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
  const decimal = parseInt(hmac.slice(0, 8), 16);
  const winValue = (decimal % 10000) / 100;
  const win = winValue < (50 - edge * 50);
  return {win, point: winValue};
};