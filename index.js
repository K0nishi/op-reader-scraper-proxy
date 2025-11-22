const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const Bottleneck = require('bottleneck');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// 1. Caching Layer
// stdTTL: 86400 seconds (24 hours)
// checkperiod: 3600 seconds (cleanup every hour)
const imgCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });

// 2. Rate Limiter for Source Website
// Limits us to 5 requests per second to the source to be polite
const limiter = new Bottleneck({
  minTime: 200, // Minimum 200ms between requests
  maxConcurrent: 5
});

// Allow requests from your frontend
app.use(cors({
    origin: process.env.FRONTEND_URL || '*' // Set this to your Vercel/Netlify URL in production
}));

app.get('/api/proxy/:chapter/:page', async (req, res) => {
    const { chapter, page } = req.params;

    // Validate inputs
    if (!/^\d+$/.test(chapter) || !/^\d+$/.test(page)) {
        return res.status(400).send('Invalid parameters');
    }

    const formattedPage = page.toString().padStart(2, '0');
    const cacheKey = `ch_${chapter}_pg_${formattedPage}`;

    // A. Check Cache (Fast Path)
    const cachedData = imgCache.get(cacheKey);
    if (cachedData) {
        // If it's a stored 404, return 404 immediately
        if (cachedData === '404') {
            return res.status(404).send('Not Found');
        }
        
        // Serve Image
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Cache', 'HIT');
        return res.send(cachedData);
    }

    // B. Fetch from Source (Slow Path - Rate Limited)
    const sourceUrl = `https://mangamoins.com/files/scans/OP${chapter}/${formattedPage}.png`;

    try {
        const response = await limiter.schedule(() => axios.get(sourceUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; OPScraperBot/1.0)'
            }
        }));

        const imgBuffer = Buffer.from(response.data, 'binary');

        // Store in cache
        imgCache.set(cacheKey, imgBuffer);

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Cache', 'MISS');
        res.send(imgBuffer);

    } catch (error) {
        if (error.response && error.response.status === 404) {
            // Negative Caching: Remember this page doesn't exist for 1 hour
            // This prevents hammering the server checking for non-existent pages
            imgCache.set(cacheKey, '404', 3600); 
            return res.status(404).send('Not Found');
        }
        
        console.error(`Error proxying ${sourceUrl}:`, error.message);
        res.status(500).send('Proxy Error');
    }
});

app.get('/', (req, res) => {
    res.send('OP Scraper Proxy is Active');
});

app.listen(PORT, () => {
    console.log(`Proxy server running on port ${PORT}`);
});
