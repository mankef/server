const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { User, SlotRound } = require('../models');

const SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '💎'];
const WEIGHTS = [40, 30, 15, 10, 5];
const PAYTABLE = {
    '💎-💎-💎': { payout: 50, name: 'Diamond Jackpot' },
    '⭐-⭐-⭐': { payout: 15, name: 'Star Win' },
    '🔔-🔔-🔔': { payout: 8, name: 'Bell Win' },
    '🍋-🍋-🍋': { payout: 4, name: 'Lemon Win' },
    '🍒-🍒-🍒': { payout: 2, name: 'Cherry Win' }
};

function getStop() {
    const r = Math.random() * 100;
    let acc = 0;
    for (let i = 0; i < WEIGHTS.length; i++) {
        acc += WEIGHTS[i];
        if (r < acc) return i;
    }
    return 0;
}

// Start spin
router.post('/spin', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        const { uid, bet } = req.body;
        
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!bet || bet < 0.01) {
            return res.status(400).json({ success: false, error: 'Minimum bet is 0.01 USDT' });
        }
        
        const user = await User.findOne({ uid }).session(session);
        if (!user || user.balance < bet) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        user.balance -= bet;
        await user.save({ session });
        
        const serverSeed = crypto.randomBytes(32).toString('hex');
        
        const round = await SlotRound.create([{
            uid,
            bet,
            serverSeed,
            serverHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
            clientSeed: null,
            reels: [],
            win: 0,
            finished: false
        }], { session });
        
        await session.commitTransaction();
        await session.endSession();
        
        res.json({
            success: true,
            roundId: round[0]._id.toString(),
            balance: user.balance,
            message: 'Spin started'
        });
        
    } catch (error) {
        await session.abortTransaction();
        await session.endSession();
        
        console.error('[SPIND BET] Spin error:', error);
        res.status(500).json({ success: false, error: 'Failed to start spin' });
    }
});

// Stop reels
router.get('/stop', async (req, res) => {
    try {
        const { roundId, reel, clientSeed } = req.query;
        
        if (!roundId || !mongoose.Types.ObjectId.isValid(roundId)) {
            return res.status(400).json({ success: false, error: 'Invalid round ID' });
        }
        
        const round = await SlotRound.findById(roundId);
        if (!round) {
            return res.status(404).json({ success: false, error: 'Round not found' });
        }
        
        if (round.finished) {
            return res.status(400).json({ success: false, error: 'Round already finished' });
        }
        
        if (!round.clientSeed) {
            round.clientSeed = clientSeed || 'default_seed';
        }
        
        const reelIndex = parseInt(reel);
        if (!round.reels[reelIndex]) {
            round.reels[reelIndex] = Array.from({ length: 3 }, () => getStop());
            await round.save();
        }
        
        res.json({
            success: true,
            stopRow: round.reels[reelIndex],
            reel: reelIndex
        });
        
    } catch (error) {
        console.error('[SPIND BET] Stop reel error:', error);
        res.status(500).json({ success: false, error: 'Failed to stop reel' });
    }
});

// Calculate result
router.get('/result', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        const { roundId } = req.query;
        
        if (!roundId || !mongoose.Types.ObjectId.isValid(roundId)) {
            return res.status(400).json({ success: false, error: 'Invalid round ID' });
        }
        
        const round = await SlotRound.findById(roundId).session(session);
        if (!round || round.finished) {
            return res.status(400).json({ success: false, error: 'Round not found or finished' });
        }
        
        if (round.reels.length !== 3 || round.reels.some(r => !r || r.length !== 3)) {
            return res.status(400).json({ success: false, error: 'Not all reels stopped' });
        }
        
        const grid = [];
        for (let reel = 0; reel < 3; reel++) {
            for (let row = 0; row < 3; row++) {
                grid.push(SYMBOLS[round.reels[reel][row]]);
            }
        }
        
        const lines = [
            [0, 1, 2], [3, 4, 5], [6, 7, 8],
            [0, 4, 8], [2, 4, 6]
        ];
        
        let totalWin = 0;
        const winningLines = [];
        
        lines.forEach((line, index) => {
            const symbols = line.map(i => grid[i]);
            const key = symbols.join('-');
            
            if (PAYTABLE[key]) {
                const winAmount = round.bet * PAYTABLE[key].payout;
                totalWin += winAmount;
                winningLines.push({
                    line: index + 1,
                    symbols: key,
                    multiplier: PAYTABLE[key].payout,
                    win: winAmount,
                    name: PAYTABLE[key].name
                });
            }
        });
        
        round.win = totalWin;
        round.finished = true;
        await round.save({ session });
        
        const user = await User.findOne({ uid: round.uid }).session(session);
        
        if (totalWin > 0) {
            user.balance += totalWin;
            user.totalWins += 1;
            
            // Referral bonus from win (1%)
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
        
        user.totalGames += 1;
        user.totalWagered += round.bet;
        await user.save({ session });
        
        await session.commitTransaction();
        await session.endSession();
        
        res.json({
            success: true,
            win: totalWin > 0,
            winAmount: totalWin,
            multiplier: totalWin / round.bet,
            winningLines,
            newBalance: user.balance,
            message: totalWin > 0 ? '🎉 WIN!' : 'Try again',
            serverSeed: round.serverSeed
        });
        
    } catch (error) {
        await session.abortTransaction();
        await session.endSession();
        
        console.error('[SPIND BET] Result error:', error);
        res.status(500).json({ success: false, error: 'Failed to calculate result' });
    }
});

module.exports = router;
