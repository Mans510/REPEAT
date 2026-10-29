const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. Add your hosted PostgreSQL connection string to .env locally and Vercel Environment Variables.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

const dbPath = 'PostgreSQL (hosted database)';

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','unsubscribed')),
      source TEXT NOT NULL DEFAULT 'website_footer',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers(created_at);

    CREATE TABLE IF NOT EXISTS drop_alerts (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      batch_name TEXT NOT NULL,
      product_name TEXT,
      created_at TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS customers (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT, address TEXT, city TEXT, state TEXT, pincode TEXT,
      total_orders INTEGER NOT NULL DEFAULT 1,
      total_spent DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(LOWER(email));
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_customers_created ON customers(created_at);

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      customer_email TEXT NOT NULL,
      customer_phone TEXT,
      shipping_address TEXT,
      city TEXT, state TEXT, pincode TEXT,
      total_amount DOUBLE PRECISION NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
      payment_method TEXT NOT NULL DEFAULT 'COD',
      payment_status TEXT NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','paid','refunded')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_order_number ON orders(order_number);
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_name TEXT NOT NULL,
      size TEXT NOT NULL DEFAULT 'M',
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price DOUBLE PRECISION NOT NULL,
      total_price DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
  `);
}
const ready = initializeDatabase();
async function q(sql, params = []) {
  await ready;
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return pool.query(sql, params);
}
function makeOrderNumber() {
  const chars = '0123456789ABCDEF';
  let rand = '';
  for (let i = 0; i < 4; i++) rand += chars[Math.floor(Math.random() * chars.length)];
  const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `RC-${dateStr}-${rand}`;
}
function placeholders(start, count) {
  return Array.from({length: count}, (_, i) => `$${start+i}`).join(', ');
}

async function addSubscriber({ email, source = 'website_footer', ipAddress = null, userAgent = null }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) throw new Error('Email address is required');
  const now = new Date().toISOString();
  const existing = (await q('SELECT * FROM subscribers WHERE LOWER(email) = $1', [cleanEmail])).rows[0];
  if (existing) {
    if (existing.status === 'active') return { alreadySubscribed: true, isNew: false, subscriber: existing, message: "You're already on the list for the next batch drop!" };
    await q("UPDATE subscribers SET status='active', updated_at=$1, source=$2, ip_address=$3, user_agent=$4 WHERE id=$5", [now, source, ipAddress, userAgent, existing.id]);
    const updated = (await q('SELECT * FROM subscribers WHERE id=$1', [existing.id])).rows[0];
    return { alreadySubscribed: false, isNew: false, reActivated: true, subscriber: updated, message: 'Welcome back! Your subscription has been reactivated.' };
  }
  const result = await q(`INSERT INTO subscribers(email,status,source,created_at,updated_at,ip_address,user_agent)
    VALUES($1,'active',$2,$3,$3,$4,$5) RETURNING *`, [cleanEmail, source, now, ipAddress, userAgent]);
  return { alreadySubscribed: false, isNew: true, subscriber: result.rows[0], message: "Locked in! You're on the list for the next batch drop." };
}
async function getSubscribers({search='', status='', limit=100, offset=0}={}) {
  const where=[], params=[];
  if (search.trim()) { params.push(`%${search.trim().toLowerCase()}%`); where.push(`LOWER(email) LIKE $${params.length}`); }
  if (status.trim()) { params.push(status.trim()); where.push(`status=$${params.length}`); }
  const clause=where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total=(await q(`SELECT COUNT(*)::int AS count FROM subscribers${clause}`,params)).rows[0].count;
  params.push(Math.max(0, Number(limit)||100), Math.max(0, Number(offset)||0));
  const rows=(await q(`SELECT id,email,status,source,created_at,updated_at FROM subscribers${clause} ORDER BY id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows;
  return { total, count: rows.length, subscribers: rows };
}
async function deleteSubscriber(id) { return (await q('DELETE FROM subscribers WHERE id=$1',[id])).rowCount > 0; }
async function unsubscribeEmail(email) {
  const clean=String(email||'').trim().toLowerCase(), now=new Date().toISOString();
  return (await q("UPDATE subscribers SET status='unsubscribed',updated_at=$1 WHERE LOWER(email)=$2",[now,clean])).rowCount>0;
}

async function createOrder(orderData) {
  const {customer, items, paymentMethod='COD', notes=''}=orderData;
  if (!customer || !customer.name || !customer.email) throw new Error('Customer name and email are required to create an order');
  if (!Array.isArray(items) || !items.length) throw new Error('Order must contain at least one item');
  const email=String(customer.email).trim().toLowerCase(), name=String(customer.name).trim();
  const cleanPhone=customer.phone ? String(customer.phone).trim() : null;
  const address=customer.address ? String(customer.address).trim() : null;
  const city=customer.city ? String(customer.city).trim() : null;
  const state=customer.state ? String(customer.state).trim() : null;
  const pincode=customer.pincode ? String(customer.pincode).trim() : null;
  const now=new Date().toISOString();
  const cleanItems=items.map(item=>{
    const quantity=Math.max(1,parseInt(item.quantity,10)||1);
    const unitPrice=Math.max(0,parseFloat(item.unitPrice || item.price)||0);
    return {productName:String(item.productName||item.name||'Batch Tee').trim(),size:String(item.size||'M').trim(),quantity,unitPrice,totalPrice:quantity*unitPrice};
  });
  const total=cleanItems.reduce((sum,item)=>sum+item.totalPrice,0);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let customerResult=await client.query('SELECT * FROM customers WHERE LOWER(email)=$1 FOR UPDATE',[email]);
    let cust=customerResult.rows[0];
    if (cust) {
      const r=await client.query(`UPDATE customers SET name=$1,phone=COALESCE($2,phone),address=COALESCE($3,address),
        city=COALESCE($4,city),state=COALESCE($5,state),pincode=COALESCE($6,pincode),
        total_orders=total_orders+1,total_spent=total_spent+$7,updated_at=$8 WHERE id=$9 RETURNING *`,
        [name,cleanPhone,address,city,state,pincode,total,now,cust.id]);
      cust=r.rows[0];
    } else {
      const r=await client.query(`INSERT INTO customers(name,email,phone,address,city,state,pincode,total_orders,total_spent,created_at,updated_at,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$9,$10) RETURNING *`,
        [name,email,cleanPhone,address,city,state,pincode,total,now,notes||null]);
      cust=r.rows[0];
    }
    const orderNumber=makeOrderNumber();
    const o=await client.query(`INSERT INTO orders(order_number,customer_id,customer_name,customer_email,customer_phone,shipping_address,city,state,pincode,total_amount,currency,status,payment_method,payment_status,created_at,updated_at,notes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'INR','confirmed',$11,'pending',$12,$12,$13) RETURNING *`,
      [orderNumber,cust.id,cust.name,cust.email,cleanPhone,address,city,state,pincode,total,paymentMethod,now,notes||null]);
    const order=o.rows[0], orderItems=[];
    for (const item of cleanItems) {
      const r=await client.query(`INSERT INTO order_items(order_id,product_name,size,quantity,unit_price,total_price)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[order.id,item.productName,item.size,item.quantity,item.unitPrice,item.totalPrice]);
      orderItems.push(r.rows[0]);
    }
    await client.query(`INSERT INTO subscribers(email,status,source,created_at,updated_at)
      VALUES($1,'active','order_checkout',$2,$2) ON CONFLICT (email) DO NOTHING`,[email,now]);
    await client.query('COMMIT');
    return {customer:cust,order,items:orderItems};
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function getCustomers({search='',sortBy='recent',limit=100,offset=0}={}) {
  const where=[],params=[];
  if(search.trim()) { const t=`%${search.trim().toLowerCase()}%`; params.push(t,t,t,t); where.push(`(LOWER(c.name) LIKE $${params.length-3} OR LOWER(c.email) LIKE $${params.length-2} OR c.phone LIKE $${params.length-1} OR LOWER(c.city) LIKE $${params.length})`); }
  const clause=where.length?` WHERE ${where.join(' AND ')}`:'';
  const countParams=params.slice();
  const total=(await q(`SELECT COUNT(*)::int AS count FROM customers c${clause}`,countParams)).rows[0].count;
  const orderBy=({spent:'c.total_spent DESC',orders:'c.total_orders DESC',name:'c.name ASC'})[sortBy]||'c.id DESC';
  params.push(Math.max(0,Number(limit)||100),Math.max(0,Number(offset)||0));
  const customers=(await q(`SELECT c.*,(SELECT order_number FROM orders WHERE customer_id=c.id ORDER BY id DESC LIMIT 1) AS latest_order_number,
    (SELECT created_at FROM orders WHERE customer_id=c.id ORDER BY id DESC LIMIT 1) AS latest_order_date
    FROM customers c${clause} ORDER BY ${orderBy} LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows;
  return {total,count:customers.length,customers};
}
async function getCustomerById(id) {
  const customer=(await q('SELECT * FROM customers WHERE id=$1',[id])).rows[0];
  if(!customer)return null;
  const orders=(await q('SELECT * FROM orders WHERE customer_id=$1 ORDER BY id DESC',[id])).rows;
  for(const order of orders) order.items=(await q('SELECT * FROM order_items WHERE order_id=$1',[order.id])).rows;
  return {customer,orders};
}
async function deleteCustomer(id) { return (await q('DELETE FROM customers WHERE id=$1',[id])).rowCount>0; }
async function getOrders({search='',status='',customerId=null,limit=100,offset=0}={}) {
  const where=[],params=[];
  if(customerId){params.push(customerId);where.push(`o.customer_id=$${params.length}`);}
  if(status.trim()){params.push(status.trim());where.push(`o.status=$${params.length}`);}
  if(search.trim()){const t=`%${search.trim().toLowerCase()}%`;const n=params.length+1;params.push(t,t,t,t,t);where.push(`(LOWER(o.order_number) LIKE $${n} OR LOWER(o.customer_name) LIKE $${n+1} OR LOWER(o.customer_email) LIKE $${n+2} OR o.customer_phone LIKE $${n+3} OR LOWER(o.city) LIKE $${n+4})`);}
  const clause=where.length?` WHERE ${where.join(' AND ')}`:'';
  const total=(await q(`SELECT COUNT(*)::int AS count FROM orders o${clause}`,params)).rows[0].count;
  params.push(Math.max(0,Number(limit)||100),Math.max(0,Number(offset)||0));
  const orders=(await q(`SELECT o.*,(SELECT COUNT(*)::int FROM order_items WHERE order_id=o.id) AS items_count,
    (SELECT STRING_AGG(product_name || ' (' || size || ' x' || quantity || ')', ', ') FROM order_items WHERE order_id=o.id) AS items_summary
    FROM orders o${clause} ORDER BY o.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params)).rows;
  return {total,count:orders.length,orders};
}
async function getOrderById(id) {
  const order=(await q('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
  if(!order)return null;
  const items=(await q('SELECT * FROM order_items WHERE order_id=$1',[id])).rows;
  const customer=(await q('SELECT * FROM customers WHERE id=$1',[order.customer_id])).rows[0]||null;
  return {order,items,customer};
}
async function updateOrderStatus(id,{status,paymentStatus,notes}={}) {
  const existing=(await q('SELECT * FROM orders WHERE id=$1',[id])).rows[0];
  if(!existing)return null;
  const result=await q(`UPDATE orders SET status=$1,payment_status=$2,notes=$3,updated_at=$4 WHERE id=$5 RETURNING *`,
    [status||existing.status,paymentStatus||existing.payment_status,notes!==undefined?notes:existing.notes,new Date().toISOString(),id]);
  return result.rows[0];
}
async function deleteOrder(id) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const r=await client.query('DELETE FROM orders WHERE id=$1 RETURNING customer_id',[id]);
    if(!r.rowCount){await client.query('COMMIT');return false;}
    const customerId=r.rows[0].customer_id;
    const remaining=(await client.query('SELECT COUNT(*)::int AS order_count,COALESCE(SUM(total_amount),0) AS total_spent FROM orders WHERE customer_id=$1',[customerId])).rows[0];
    await client.query('UPDATE customers SET total_orders=$1,total_spent=$2,updated_at=$3 WHERE id=$4',[remaining.order_count,remaining.total_spent,new Date().toISOString(),customerId]);
    await client.query('COMMIT');return true;
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}
async function getStats() {
  const totalSubscribers=(await q('SELECT COUNT(*)::int AS count FROM subscribers')).rows[0].count;
  const activeSubscribers=(await q("SELECT COUNT(*)::int AS count FROM subscribers WHERE status='active'")).rows[0].count;
  const cs=(await q('SELECT COUNT(*)::int AS total_customers,COALESCE(SUM(total_spent),0) AS total_revenue FROM customers')).rows[0];
  const os=(await q(`SELECT COUNT(*)::int AS total_orders,
    SUM(CASE WHEN status IN ('confirmed','processing','shipped') THEN 1 ELSE 0 END)::int AS active_orders,
    SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END)::int AS delivered_orders FROM orders`)).rows[0];
  const totalOrders=os.total_orders||0,totalRevenue=Number(cs.total_revenue)||0;
  const recentCustomers=(await q('SELECT id,name,email,phone,city,total_orders,total_spent,created_at FROM customers ORDER BY id DESC LIMIT 5')).rows;
  const recentOrders=(await q('SELECT id,order_number,customer_name,total_amount,status,created_at FROM orders ORDER BY id DESC LIMIT 5')).rows;
  return {totalSubscribers,activeSubscribers,unsubscribedCount:totalSubscribers-activeSubscribers,totalCustomers:cs.total_customers,totalOrders,totalRevenue,avgOrderValue:totalOrders?Math.round(totalRevenue/totalOrders):0,activeOrders:os.active_orders||0,deliveredOrders:os.delivered_orders||0,recentCustomers,recentOrders};
}
async function seedInitialData() {
  // Intentionally no automatic demo orders in production; real customer/order data must not be fabricated.
}
module.exports={dbPath,ready,pool,addSubscriber,getSubscribers,deleteSubscriber,unsubscribeEmail,createOrder,getCustomers,getCustomerById,deleteCustomer,getOrders,getOrderById,updateOrderStatus,deleteOrder,getStats,seedInitialData};
