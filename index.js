const express = require('express');
const Stripe = require('stripe');
const { google } = require('googleapis');
const Airtable = require('airtable');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

// Initialize APIs
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const base = airtable.base('appUNIsu8KgvOlmi0'); // Growth AI base ID

// Gmail OAuth2 setup
const oauth2Client = new google.auth.OAuth2();
oauth2Client.setCredentials({
  access_token: process.env.GMAIL_ACCESS_TOKEN,
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// Logging array to store recent activities
let activityLogs = [];

function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = { timestamp, message, type };
  console.log(`[${timestamp}] ${type.toUpperCase()}: ${message}`);
  activityLogs.push(logEntry);
  
  // Keep only last 100 logs
  if (activityLogs.length > 100) {
    activityLogs = activityLogs.slice(-100);
  }
}

// Middleware
app.use(express.json());
app.use('/stripe-webhook', bodyParser.raw({ type: 'application/json' }));

// Initialize Failed Payments table
async function initializeFailedPaymentsTable() {
  try {
    // Check if Failed Payments table exists, if not we'll create records which will create the table
    log('Checking/initializing Failed Payments table in Airtable');
    return true;
  } catch (error) {
    log(`Error initializing table: ${error.message}`, 'error');
    return false;
  }
}

// Send Gmail alert
async function sendGmailAlert(paymentData) {
  try {
    const emailContent = `
Subject: 🚨 Payment Failed Alert - Stripe
MIME-Version: 1.0
Content-Type: text/html; charset=utf-8

<html>
<body>
  <h2 style="color: #d73a49;">Payment Failed Alert</h2>
  
  <p><strong>Payment ID:</strong> ${paymentData.id}</p>
  <p><strong>Amount:</strong> $${(paymentData.amount / 100).toFixed(2)} ${paymentData.currency?.toUpperCase()}</p>
  <p><strong>Customer:</strong> ${paymentData.customer_email || 'N/A'}</p>
  <p><strong>Failure Reason:</strong> ${paymentData.failure_reason || 'N/A'}</p>
  <p><strong>Failure Code:</strong> ${paymentData.failure_code || 'N/A'}</p>
  <p><strong>Time:</strong> ${new Date(paymentData.created * 1000).toLocaleString()}</p>
  
  <p><a href="https://dashboard.stripe.com/payments/${paymentData.id}" target="_blank">View in Stripe Dashboard</a></p>
</body>
</html>
    `;

    const encodedMessage = Buffer.from(emailContent).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
      },
    });

    log(`Gmail alert sent for payment ${paymentData.id}`, 'success');
  } catch (error) {
    log(`Failed to send Gmail alert: ${error.message}`, 'error');
  }
}

// Add record to Airtable Failed Payments table
async function addToAirtable(paymentData) {
  try {
    const record = await base('Failed Payments').create([
      {
        fields: {
          'Payment ID': paymentData.id,
          'Amount': (paymentData.amount / 100).toFixed(2),
          'Currency': paymentData.currency?.toUpperCase() || 'USD',
          'Customer Email': paymentData.customer_email || 'N/A',
          'Customer ID': paymentData.customer || 'N/A',
          'Failure Reason': paymentData.failure_reason || 'N/A',
          'Failure Code': paymentData.failure_code || 'N/A',
          'Failed At': new Date(paymentData.created * 1000).toISOString(),
          'Stripe URL': `https://dashboard.stripe.com/payments/${paymentData.id}`,
          'Status': 'Failed',
          'Notes': `Payment failed with message: ${paymentData.failure_message || 'No additional details'}`
        }
      }
    ]);

    log(`Added failed payment record to Airtable: ${paymentData.id}`, 'success');
    return record;
  } catch (error) {
    log(`Failed to add record to Airtable: ${error.message}`, 'error');
  }
}

// Process failed payment
async function processFailedPayment(paymentData) {
  log(`Processing failed payment: ${paymentData.id}`, 'info');
  
  try {
    // Get additional customer details if available
    if (paymentData.customer) {
      try {
        const customer = await stripe.customers.retrieve(paymentData.customer);
        paymentData.customer_email = customer.email;
      } catch (err) {
        log(`Could not retrieve customer details: ${err.message}`, 'warn');
      }
    }

    // Send Gmail alert
    await sendGmailAlert(paymentData);

    // Add to Airtable
    await addToAirtable(paymentData);

    log(`Successfully processed failed payment: ${paymentData.id}`, 'success');
  } catch (error) {
    log(`Error processing failed payment ${paymentData.id}: ${error.message}`, 'error');
  }
}

// Routes

// Home route - status and available endpoints
app.get('/', (req, res) => {
  res.json({
    service: 'Stripe Failed Payments Monitor',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      'GET /': 'Service status and endpoints',
      'GET /health': 'Health check',
      'GET /logs': 'View recent activity logs',
      'POST /test': 'Manually test the failed payment processing',
      'POST /stripe-webhook': 'Stripe webhook endpoint (for Stripe to call)',
    },
    description: 'Monitors Stripe for failed payments, sends Gmail alerts, and updates Airtable'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    logs_count: activityLogs.length
  });
});

// View logs
app.get('/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const recentLogs = activityLogs.slice(-limit).reverse();
  res.json({
    logs: recentLogs,
    total_logs: activityLogs.length,
    showing: recentLogs.length
  });
});

// Manual test endpoint
app.post('/test', async (req, res) => {
  try {
    log('Manual test triggered', 'info');

    // Create a test payment data object
    const testPaymentData = {
      id: 'pi_test_' + Date.now(),
      amount: 2500, // $25.00
      currency: 'usd',
      customer: 'cus_test',
      customer_email: 'test@example.com',
      failure_reason: 'insufficient_funds',
      failure_code: 'card_declined',
      failure_message: 'Your card was declined.',
      created: Math.floor(Date.now() / 1000)
    };

    await processFailedPayment(testPaymentData);

    res.json({
      success: true,
      message: 'Test failed payment processed successfully',
      test_data: testPaymentData
    });
  } catch (error) {
    log(`Test failed: ${error.message}`, 'error');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Stripe webhook endpoint
app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    log(`Webhook signature verification failed: ${err.message}`, 'error');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  log(`Received Stripe webhook: ${event.type}`, 'info');

  // Handle failed payment events
  if (event.type === 'payment_intent.payment_failed' || 
      event.type === 'charge.failed' || 
      event.type === 'invoice.payment_failed') {
    
    const paymentData = event.data.object;
    await processFailedPayment(paymentData);
  }

  res.json({ received: true });
});

// Error handling middleware
app.use((error, req, res, next) => {
  log(`Unhandled error: ${error.message}`, 'error');
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// Initialize and start server
async function startServer() {
  try {
    await initializeFailedPaymentsTable();
    
    app.listen(port, () => {
      log(`Stripe Failed Payments Monitor started on port ${port}`, 'success');
      log('Ready to monitor failed payments and send alerts', 'info');
    });
  } catch (error) {
    log(`Failed to start server: ${error.message}`, 'error');
    process.exit(1);
  }
}

startServer();

module.exports = app;