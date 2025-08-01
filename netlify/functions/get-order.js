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

    // Get ShipStation v2 API credentials
    const apiKey = process.env.SHIPSTATION_PRODUCTION_KEY;

    if (!apiKey) {
      console.error('Missing ShipStation production key');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error' })
      };
    }

    // Search for order by number and email using v2 API
    const searchParams = new URLSearchParams({
      orderNumber: orderNumber.trim(),
      customerEmail: email.trim().toLowerCase()
    });

    // Call ShipStation v2 API for orders
    const orderData = await makeShipStationV2Request(`/orders?${searchParams}`, apiKey);

    if (!orderData.orders || orderData.orders.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address.' })
      };
    }

    // Get the matching order
    const order = orderData.orders[0];

    // Get all shipments for this order using v2 API
    let shipments = [];
    if (order.orderStatus === 'shipped' || order.orderStatus === 'delivered') {
      try {
        const shipmentData = await makeShipStationV2Request(`/shipments?orderNumber=${orderNumber.trim()}`, apiKey);
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          shipments = shipmentData.shipments;
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
      shipments: shipments.map((shipment, index) => ({
        shipmentId: shipment.shipmentId,
        trackingNumber: shipment.trackingNumber,
        trackingUrl: shipment.trackingUrl, // v2 API provides this directly
        carrierCode: shipment.carrierCode,
        shipDate: shipment.shipDate,
        deliveryDate: shipment.deliveryDate || null,
        shipmentNumber: index + 1,
        totalShipments: shipments.length
      }))
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

// Helper function to make ShipStation v2 API requests
function makeShipStationV2Request(endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    
    const options = {
      hostname: 'api.shipstation.com',
      path: `/v2${endpoint}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Drought-Order-Tracker/2.0'
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
          resolve({ orders: [], shipments: [] }); // No data found
        } else {
          reject(new Error(`ShipStation API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`));
    });

    // Set 15 second timeout
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}