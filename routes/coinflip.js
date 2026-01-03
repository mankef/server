const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { User, CoinflipGame } = require('../models');

// Start coinflip
router.post('/start', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        const { uid, bet, choice } = req.body;
        
        if (!uid || typeof uid !== 'number') {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        if (!bet || bet < 0.01) {
            return res.status(400).json({ success: false, error: 'Minimum bet is 0.01 USDT' });
        }
        if (!['heads', 'tails'].includes(choice)) {
            return res.status(400).json({ success: false, error: 'Choose heads or tails' });
        }
        
        const user = await User.findOne({ uid }).session(session);
        if (!user || user.balance < bet) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }
        
        user.balance -= bet;
        await user.save({ session });
        
        const serverSeed = crypto.randomBytes(32).toString('hex');
        const serverHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
        
        const game = await CoinflipGame.create([{
            uid,
            bet,
            choice,
            serverSeed,
            serverHash,
            clientSeed: null,
            result: null,
            win: 0,
            finished: false
        }], { session });
        
        await session.commitTransaction();
        await session.endSession();
        
        res.json({
            success: true,
            gameId: game[0]._id.toString(),
            balance: user.balance,
            serverHash: serverHash,
            message: 'Coinflip started'
        });
        
    } catch (error) {
        await session.abortTransaction();
        await session.endSession();
        
        console.error('[SPIND BET] Coinflip start error:', error);
        res.status(500).json({ success: false, error: 'Failed to start game' });
    }
});

// Flip coin
router.get('/flip', async (req, res) => {
    try {
        const { gameId, clientSeed } = req.query;
        
        if (!gameId || !mongoose.Types.ObjectId.isValid(gameId)) {
            return res.status(400).json({ success: false, error: 'Invalid game ID' });
        }
        
        const game = await CoinflipGame.findById(gameId);
        if (!game || game.finished) {
            return res.status(400).json({ success: false, error: 'Game not found or finished' });
        }
        
        if (!clientSeed) {
            return res.status(400).json({ success: false, error: 'Client seed required' });
        }
        
        if (game.clientSeed) {
            return res.status(400).json({ success: false, error: 'Already flipped' });
        }
        
        game.clientSeed = clientSeed;
        await game.save();
        
        const result = crypto.createHash('sha256')
            .update(game.serverSeed + clientSeed)
            .digest('hex')
            .slice(0, 8);
        
        const isHeads = parseInt(result, 16) % 2 === 0;
        const outcome = isHeads ? 'heads' : 'tails';
        const win = outcome === game.choice;
        const winAmount = win ? game.bet * 2 : 0;
        
        res.json({
            success: true,
            outcome,
            heads: isHeads,
            serverSeed: game.serverSeed,
            verifyHash: crypto.createHash('sha256').update(game.serverSeed).digest('hex')
        });
        
    } catch (error) {
        console.error('[SPIND BET] Coinflip error:', error);
        res.status(500).json({ success: false, error: 'Failed to flip coin' });
    }
});

// Settle coinflip
router.get('/settle', async (req, res) => {
    const session = await mongoose.startSession();
    
    try {
        const { gameId } = req.query;
        
        if (!gameId || !mongoose.Types.ObjectId.isValid(gameId)) {
            return res.status(400).json({ success: false, error: 'Invalid game ID' });
        }
        
        const game = await CoinflipGame.findById(gameId).session(session);
        if (!game || game.finished) {
            return res.status(400).json({ success: false, error: 'Game not found or finished' });
        }
        
        if (!game.clientSeed) {
            return res.status(400).json({ success: false, error: 'Coin not flipped yet' });
        }
        
        const result = crypto.createHash('sha256')
            .update(game.serverSeed + game.clientSeed)
            .digest('hex')
            .slice(0, 8);
        
        const isHeads = parseInt(result, 16) % 2 === 0;
        const outcome = isHeads ? 'heads' : 'tails';
        const win = outcome === game.choice;
        const winAmount = win ? game.bet * 2 : 0;
        
        game.result = outcome;
        game.win = winAmount;
        game.finished = true;
        await game.save({ session });
        
        const user = await User.findOne({ uid: game.uid }).session(session);
        
        if (win) {
            user.balance += winAmount;
            user.totalWins += 1;
            
            // Referral bonus (1% from win)
            if (user.ref) {
                const ref1 = await User.findOne({ uid: user.ref }).session(session);
                if (ref1) {
                    const refBonus = winAmount * 0.01;
                    ref1.balance += refBonus;
                    ref1.refEarn += refBonus;
                    await ref1.save({ session });
                }
            }
        }
        
        user.totalGames += 1;
        user.totalWagered += game.bet;
        await user.save({ session });
        
        await session.commitTransaction();
        await session.endSession();
        
        res.json({
            success: true,
            win,
            winAmount,
            outcome,
            newBalance: user.balance,
            message: win ? '🎉 YOU WIN!' : '💔 You lose'
        });
        
    } catch (error) {
        await session.abortTransaction();
        await session.endSession();
        
        console.error('[SPIND BET] Settle error:', error);
        res.status(500).json({ success: false, error: 'Failed to settle game' });
    }
});

module.exports = router;
