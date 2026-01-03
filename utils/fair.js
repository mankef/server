const crypto = require('crypto');

/**
 * Генерирует серверный сид для проверяемой игры
 * @returns {{serverSeed: string, hash: string}}
 */
exports.generateRound = () => {
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256')
        .update(serverSeed)
        .digest('hex');
    
    return { serverSeed, hash };
};

/**
 * Рассчитывает результат на основе сидов
 * @param {string} serverSeed - Серверный сид
 * @param {string} clientSeed - Клиентский сид
 * @param {number} houseEdge - Преимущество казино (0-0.3)
 * @returns {{win: boolean, point: number, probability: number}}
 */
exports.calculateWin = (serverSeed, clientSeed, houseEdge = 0.05) => {
    // Создать HMAC для проверяемого результата
    const hmac = crypto.createHmac('sha256', serverSeed)
        .update(clientSeed)
        .digest('hex');
    
    // Преобразовать первые 8 символов в число (0-4294967295)
    const decimal = parseInt(hmac.slice(0, 8), 16);
    
    // Нормализовать до 0-9999
    const point = decimal % 10000;
    
    // Рассчитать вероятность выигрыша (50% - houseEdge)
    const winProbability = (0.5 - houseEdge) * 10000;
    const win = point < winProbability;
    
    return {
        win,
        point: point / 100, // Для отображения (0-99.99)
        probability: winProbability / 100
    };
};

/**
 * Проверяет честность раунда
 * @param {string} serverSeed - Серверный сид
 * @param {string} hash - Хэш серверного сида
 * @returns {boolean}
 */
exports.verifyHash = (serverSeed, hash) => {
    const calculatedHash = crypto.createHash('sha256')
        .update(serverSeed)
        .digest('hex');
    
    return calculatedHash === hash;
};

module.exports = exports;
