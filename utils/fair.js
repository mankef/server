const crypto = require('crypto');

exports.generateRound = () => {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    return { serverSeed, hash };
};

exports.calculateWin = (serverSeed, clientSeed, houseEdge = 0.05) => {
    const hmac = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
    const decimal = parseInt(hmac.slice(0, 8), 16);
    const point = decimal % 10000;
    const winProbability = (0.5 - houseEdge) * 10000;
    const win = point < winProbability;
    
    return {
        win,
        point: point / 100,
        probability: winProbability / 100,
        result: hmac
    };
};

exports.verifyHash = (serverSeed, hash) => {
    return crypto.createHash('sha256').update(serverSeed).digest('hex') === hash;
};

exports.getCoinflipResult = (serverSeed, clientSeed) => {
    const hash = crypto.createHmac('sha256', serverSeed).update(clientSeed).digest('hex');
    const result = parseInt(hash.slice(0, 8), 16) % 2 === 0;
    return { isHeads: result, hash };
};
