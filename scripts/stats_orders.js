const { MongoClient } = require('mongodb');
require('dotenv').config();

(async () => {
  const uri = process.argv[2] || process.env.MONGO_URI;
  const collName = process.argv[3] || 'orders';
  if (!uri) { console.error('Missing MONGO_URI'); process.exit(1); }

  const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  try {
    await client.connect();
    const db = client.db(); // DB from URI
    const coll = db.collection(collName);

    const total = await coll.countDocuments();
    console.log('total orders =', total);

    // distinct users
    const users = await coll.distinct('userId');
    console.log('distinct users (sample 10) =', users.slice(0,10).length, ' total distinct users =', users.length);

    // collect product ids from items array and count distinct
    const pipeline = [
      { $unwind: '$items' },
      { $project: { pid: ['$items.productId','$items.product','items.productId','items.product'] } },
      { $addFields: { pid: { $ifNull: [ { $arrayElemAt: ['$pid',0] }, null ] } } },
      { $match: { pid: { $ne: null } } },
      { $group: { _id: '$pid', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 }
    ];
    const top = await coll.aggregate(pipeline).toArray();
    console.log('top products in orders (up to 20):');
    top.forEach((r,i) => console.log(i+1, r._id, 'count=', r.count));
    console.log('distinct product keys reported =', top.length ? '>=1' : 0);
  } catch (e) {
    console.error('error', e.message);
  } finally {
    await client.close();
  }
})();