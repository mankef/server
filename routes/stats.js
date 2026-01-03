const express = require('express');
const router = express.Router();
const { User, Invoice, SlotRound, CoinflipGame } = require('../models');

// Get full statistics
router.get('/global', async (req, res) => {
    try {
        const [
            totalUsers,
            totalDeposited,
            totalWithdrawn,
            activeUsers,
            topPlayers
        ] = await Promise.all([
            User.countDocuments(),
            User.aggregate([{ $group: { _id: null, total: { $sum: '$totalDeposited' } } }]),
            User.aggregate([{ $group: { _id: null, total: { $sum: '$totalWithdrawn' } } }]),
            User.countDocuments({ lastBonus: { $gt: Date.now() - 24 * 60 * 60 * 1000 } }),
            User.find()
                .sort({ totalWagered: -1 })
                .limit(10)
                .select('uid totalWagered totalWins balance')
                .lean()
        ]);
        
        const slotsStats = await SlotRound.aggregate([
            { $match: { finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' } } }
        ]);
        
        const coinflipStats = await CoinflipGame.aggregate([
            { $match: { finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' } } }
        ]);
        
        res.json({
            success: true,
            stats: {
                users: {
                    total: totalUsers,
                    active24h: activeUsers
                },
                financial: {
                    totalDeposited: totalDeposited[0]?.total || 0,
                    totalWithdrawn: totalWithdrawn[0]?.total || 0,
                    houseProfit: (totalDeposited[0]?.total || 0) - (totalWithdrawn[0]?.total || 0)
                },
                games: {
                    slots: {
                        totalWagered: slotsStats[0]?.totalWagered || 0,
                        totalWins: slotsStats[0]?.totalWins || 0
                    },
                    coinflip: {
                        totalWagered: coinflipStats[0]?.totalWagered || 0,
                        totalWins: coinflipStats[0]?.totalWins || 0
                    }
                },
                topPlayers: topPlayers.map(p => ({
                    uid: p.uid,
                    wagered: p.totalWagered || 0,
                    wins: p.totalWins || 0,
                    balance: p.balance || 0
                }))
            }
        });
        
    } catch (error) {
        console.error('[SPIND BET] Global stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to load statistics' });
    }
});

// Get user stats
router.get('/user/:uid', async (req, res) => {
    try {
        const uid = parseInt(req.params.uid);
        if (isNaN(uid)) {
            return res.status(400).json({ success: false, error: 'Invalid user ID' });
        }
        
        const user = await User.findOne({ uid });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        const slotsStats = await SlotRound.aggregate([
            { $match: { uid, finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' } } }
        ]);
        
        const coinflipStats = await CoinflipGame.aggregate([
            { $match: { uid, finished: true } },
            { $group: { _id: null, totalWagered: { $sum: '$bet' }, totalWins: { $sum: '$win' }, totalGames: { $sum: 1 } } }
        ]);
        
        res.json({
            success: true,
            stats: {
                balance: user.balance,
                totalDeposited: user.totalDeposited || 0,
                totalWithdrawn: user.totalWithdrawn || 0,
                refEarn: user.refEarn || 0,
                slots: {
                    totalWagered: slotsStats[0]?.totalWagered || 0,
                    totalWins: slotsStats[0]?.totalWins || 0
                },
                coinflip: {
                    totalWagered: coinflipStats[0]?.totalWagered || 0,
                    totalWins: coinflipStats[0]?.totalWins || 0,
                    totalGames: coinflipStats[0]?.totalGames || 0,
                    winRate: coinflipStats[0]?.totalGames ? (slotsStats[0]?.totalWins || 0 + coinflipStats[0]?.totalWins || 0) / (slotsStats[0]?.totalWagered + coinflipStats[0]?.totalWagered) : 0
                }
            }
        });
        
    } catch (error) {
        console.error('[SPIND BET] User stats error:', error);
        res.status(500).json({ success: false, error: 'Failed to load user statistics' });
    }
});

module.exports = router;
