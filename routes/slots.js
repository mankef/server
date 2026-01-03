const express = require('express');
const router = express.Router();
const { SlotRound, User } = require('../models');
const mongoose = require('mongoose');

const SYMBOLS = ['🍒', '🍋', '🔔', 'BAR', '💎'];
const WEIGHTS = [40, 30, 15, 10, 5];
const PAYTABLE = {
    '💎-💎-💎': 50,
    'BAR-BAR-BAR': 15,
    '🔔-🔔-🔔': 8,
    '🍋-🍋-🍋': 4,
    '🍒-🍒-🍒': 2
};

// Получить случайную остановку
function getStop() {
    const r = Math.random() * 100;
    let acc = 0;
    for (let i = 0; i < WEIGHTS.length; i++) {
        acc += WEIGHTS[i];
        if (r < acc) return i;
    }
    return 0;
}

// Начать спин
router.post('/slots/spin', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        await session.withTransaction(async () => {
            const { uid, bet } = req.body;
            
            // Валидация
            if (!uid || typeof uid !== 'number') {
                throw new Error('Invalid user ID');
            }
            if (!bet || bet < 0.01) {
                throw new Error('Minimum bet is 0.01');
            }
            
            const user = await User.findOne({ uid }).session(session);
            if (!user || user.balance < bet) {
                throw new Error('Insufficient balance');
            }
            
            // Списать ставку
            user.balance -= bet;
            await user.save({ session });
            
            // Создать раунд
            const round = await SlotRound.create([{
                uid,
                bet,
                reels: [],
                status: 'active'
            }], { session });
            
            res.json({
                success: true,
                roundId: round[0]._id.toString(),
                newBalance: user.balance,
                message: 'Spin started'
            });
        });
        
    } catch (error) {
        res.status(400).json({ 
            success: false, 
            error: error.message 
        });
    } finally {
        await session.endSession();
    }
});

// Остановить барабан
router.get('/slots/stop', async (req, res) => {
    try {
        const { roundId, reel } = req.query;
        
        if (!roundId || !mongoose.Types.ObjectId.isValid(roundId)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid round ID' 
            });
        }
        
        if (!reel || reel < 0 || reel > 2) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid reel number' 
            });
        }
        
        const round = await SlotRound.findById(roundId);
        if (!round) {
            return res.status(404).json({ 
                success: false, 
                error: 'Round not found' 
            });
        }
        
        if (round.status !== 'active') {
            return res.status(400).json({ 
                success: false, 
                error: 'Round already finished' 
            });
        }
        
        if (!round.reels[reel]) {
            round.reels[reel] = Array.from({ length: 3 }, () => getStop());
            await round.save();
        }
        
        res.json({
            success: true,
            stopRow: round.reels[reel],
            reel: parseInt(reel)
        });
        
    } catch (error) {
        console.error('[SPIND BET] Stop reel error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to stop reel' 
        });
    }
});

// Рассчитать выигрыш
router.get('/slots/win', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        const { roundId } = req.query;
        
        if (!roundId || !mongoose.Types.ObjectId.isValid(roundId)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid round ID' 
            });
        }
        
        const round = await SlotRound.findById(roundId).session(session);
        if (!round || round.status !== 'active') {
            return res.status(400).json({ 
                success: false, 
                error: 'Round not found or already finished' 
            });
        }
        
        // Проверить что все барабаны остановлены
        if (round.reels.length !== 3 || round.reels.some(r => !r || r.length !== 3)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Not all reels stopped' 
            });
        }
        
        // Построить сетку
        const grid = [];
        for (let reel = 0; reel < 3; reel++) {
            for (let row = 0; row < 3; row++) {
                grid.push(SYMBOLS[round.reels[reel][row]]);
            }
        }
        
        // Проверить линии
        const lines = [
            [0, 1, 2], // Top
            [3, 4, 5], // Middle
            [6, 7, 8], // Bottom
            [0, 4, 8], // Diagonal 1
            [2, 4, 6]  // Diagonal 2
        ];
        
        let totalWin = 0;
        const winningLines = [];
        
        lines.forEach((line, index) => {
            const [a, b, c] = line.map(i => grid[i]);
            const key = `${a}-${b}-${c}`;
            const multiplier = PAYTABLE[key];
            
            if (multiplier) {
                const winAmount = round.bet * multiplier;
                totalWin += winAmount;
                winningLines.push({
                    line: index + 1,
                    symbols: key,
                    multiplier,
                    win: winAmount
                });
            }
        });
        
        // Завершить раунд
        round.win = totalWin;
        round.finished = true;
        round.status = totalWin > 0 ? 'won' : 'lost';
        await round.save({ session });
        
        // Выплатить выигрыш
        const user = await User.findOne({ uid: round.uid }).session(session);
        if (totalWin > 0) {
            user.balance += totalWin;
            await user.save({ session });
            
            // Реферальные 1% от выигрыша
            if (user.ref) {
                const ref1 = await User.findOne({ uid: user.ref }).session(session);
                if (ref1) {
                    const refBonus = totalWin * 0.01;
                    ref1.balance += refBonus;
                    ref1.refEarn += refBonus;
                    await ref1.save({ session });
                }
            }
        }
        
        await session.commitTransaction();
        await session.endSession();
        
        res.json({
            success: true,
            win: totalWin > 0,
            winAmount: totalWin,
            multiplier: totalWin / round.bet,
            winningLines,
            newBalance: user.balance,
            message: totalWin > 0 ? 
                `🎉 Won ${totalWin.toFixed(2)} USDT!` : 
                '❌ No win this time'
        });
        
    } catch (error) {
        await session.abortTransaction();
        await session.endSession();
        
        console.error('[SPIND BET] Calculate win error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to calculate win' 
        });
    }
});

module.exports = router;
