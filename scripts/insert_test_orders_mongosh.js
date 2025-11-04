// Usage: mongosh "mongodb+srv://<USER>:<PASS>@<HOST>/KL-Data" insert_test_orders_mongosh.js
// This script finds an existing product (or creates one) and inserts two sample orders in September 2025
// Run with mongosh connected to the KL-Data database.

// Notes: adjust phone/address or product fields as you wish.

(function(){
  // db is available in mongosh when connected to a database
  print('Starting insert_test_orders_mongosh.js');

  // Try to find an existing product with variants
  let prod = db.products.findOne({});
  if (!prod) {
    print('No product found in `products` collection — creating a sample product');
    const newProd = {
      name: 'Áo Thun Test - Fake',
      slug: 'ao-thun-test-fake',
      shortDescription: 'Sản phẩm tạo để test; không dùng cho production',
      categoryId: ObjectId(),
      brand: 'TestBrand',
      tags: ['test'],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
      variants: []
    };

    // create a couple of variants
    const v1 = ObjectId();
    const v2 = ObjectId();
    newProd.variants.push(v1, v2);

    const res = db.products.insertOne(newProd);
    prod = db.products.findOne({_id: res.insertedId});
    print('Inserted sample product with _id=' + String(prod._id));
  } else {
    print('Found existing product _id=' + String(prod._id));
    // ensure there is at least one variant id available
    if (!prod.variants || prod.variants.length === 0) {
      const v = ObjectId();
      db.products.updateOne({_id: prod._id}, {$set: {variants: [v], updatedAt: new Date()}});
      prod = db.products.findOne({_id: prod._id});
      print('Added a variant id to existing product: ' + String(v));
    }
  }

  // choose first variant
  const variantId = prod.variants[0];

  // Build two orders in September 2025
  const order1 = {
    orderCode: 'TEST-SEP-001',
    items: [
      {
        productId: prod._id,
        variantId: variantId,
        name: prod.name || 'Sample product',
        sku: 'TEST-SKU-001',
        quantity: 1,
        price: 150000
      }
    ],
    shippingAddress: {
      fullName: 'Nguyen Van A',
      phone: '0901234567',
      address: '123 Đường Lê Lợi, Quận 1, TP.HCM'
    },
    paymentMethod: {
      type: 'COD',
      status: 'paid',
      note: 'Thanh toán khi nhận hàng'
    },
    orderStatus: 'confirmed',
    subtotal: 150000,
    shippingFee: 30000,
    discount: 0,
    totalAmount: 180000,
    createdAt: new Date('2025-09-10T08:30:00Z'),
    updatedAt: new Date('2025-09-10T08:30:00Z')
  };

  const order2 = {
    orderCode: 'TEST-SEP-002',
    items: [
      {
        productId: prod._id,
        variantId: variantId,
        name: prod.name || 'Sample product',
        sku: 'TEST-SKU-001',
        quantity: 3,
        price: 150000
      }
    ],
    shippingAddress: {
      fullName: 'Tran Thi B',
      phone: '0912345678',
      address: '456 Đường Trần Hưng Đạo, Quận 5, TP.HCM'
    },
    paymentMethod: {
      type: 'PayOS',
      status: 'paid',
      transactionId: 'PAYOS-TEST-20250915-01',
      invoiceUrl: 'https://payos.example/invoice/PAYOS-TEST-20250915-01'
    },
    orderStatus: 'confirmed',
    subtotal: 450000,
    shippingFee: 30000,
    discount: 0,
    totalAmount: 480000,
    createdAt: new Date('2025-09-15T10:00:00Z'),
    updatedAt: new Date('2025-09-15T10:00:00Z')
  };

  // Insert orders
  const insertRes = db.orders.insertMany([order1, order2]);
  print('Inserted orders IDs: ' + JSON.stringify(insertRes.insertedIds));
  print('Done. You can now re-run the forecast script to see the impact.');
})();
