exports.handler = async (event, context) => {
  // CORS headers for your domain
  const headers = {
    'Access-Control-Allow-Origin': 'https://www.cameupinthedrought.com',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Parse request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid request format' })
      };
    }

    const { orderNumber, email } = requestBody;

    // Validate inputs
    if (!orderNumber || !email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order number and email are required' })
      };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid email format' })
      };
    }

    // Get ShipStation API credentials
    const apiKey = process.env.SHIPSTATION_API_KEY;
    const apiSecret = process.env.SHIPSTATION_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.error('Missing ShipStation API credentials');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error' })
      };
    }

    // Create auth header for ShipStation
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    // Search for order by number and email
    const searchParams = new URLSearchParams({
      orderNumber: orderNumber.trim(),
      customerEmail: email.trim().toLowerCase()
    });

    // Call ShipStation API
    const orderData = await makeShipStationRequest(`/orders?${searchParams}`, auth);

    if (!orderData.orders || orderData.orders.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address.' })
      };
    }

    // Get the matching order
    const order = orderData.orders[0];

    // Get tracking information if order is shipped
    let trackingInfo = null;
    if (order.orderStatus === 'shipped' || order.orderStatus === 'delivered') {
      try {
        const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${orderNumber.trim()}`, auth);
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          const shipment = shipmentData.shipments[0];
          trackingInfo = {
            trackingNumber: shipment.trackingNumber,
            carrierCode: shipment.carrierCode,
            shipDate: shipment.shipDate
          };
        }
      } catch (shipmentError) {
        console.log('Could not fetch shipment info:', shipmentError.message);
        // Continue without tracking info rather than failing
      }
    }

    // Format response for your frontend
    const response = {
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      orderDate: order.orderDate,
      orderStatus: order.orderStatus.toLowerCase(),
      trackingNumber: trackingInfo?.trackingNumber || null,
      carrierCode: trackingInfo?.carrierCode || null,
      shipDate: trackingInfo?.shipDate || null,
      deliveryDate: null // ShipStation doesn't provide delivery confirmation
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('Function error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Unable to retrieve order information. Please try again.'
      })
    };
  }
};

// Helper function to make ShipStation API requests
function makeShipStationRequest(endpoint, auth) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    
    const options = {
      hostname: 'ssapi.shipstation.com',
      path: endpoint,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Drought-Order-Tracker/1.0'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (parseError) {
            reject(new Error('Invalid response from ShipStation'));
          }
        } else if (res.statusCode === 401) {
          reject(new Error('Invalid ShipStation API credentials'));
        } else if (res.statusCode === 404) {
          resolve({ orders: [] }); // No orders found
        } else {
          reject(new Error(`ShipStation API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`));
    });

    // Set 10 second timeout
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}