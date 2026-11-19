const { sweep } = require('./api');
exports.handler = async () => { await sweep(); return { statusCode: 200 }; };
