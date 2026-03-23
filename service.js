// service.js
// simple wrapper: require your main bot file and start a tiny HTTP health endpoint
// require('./hike_and_fab_4.0.js'); // adjust path if your main file is named differently
require('./FVG_mexcjs'); // adjust path if your main file is named differently

// optional health server so platform health checks succeed
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('ok'));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Health server listening on ${port}`));
