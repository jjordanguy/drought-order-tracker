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

    // Get ShipStation V1 API credentials
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

    // Create auth header for ShipStation V1
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    // Search for order by number and email
    const searchParams = new URLSearchParams({
      orderNumber: orderNumber.trim(),
      customerEmail: email.trim().toLowerCase()
    });

    console.log(`Searching for order: ${orderNumber.trim()} with email: ${email.trim().toLowerCase()}`);

    // Call ShipStation V1 API for orders
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
    console.log(`Found order: ${order.orderNumber} with status: ${order.orderStatus}`);

    // Get tracking information if order is shipped
    let shipments = [];
    if (order.orderStatus === 'shipped' || order.orderStatus === 'delivered') {
      try {
        console.log(`Fetching shipments for order: ${orderNumber.trim()}`);
        const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${orderNumber.trim()}`, auth);
        
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          console.log(`Found ${shipmentData.shipments.length} shipments`);
          
          // Process each shipment
          shipmentData.shipments.forEach((shipment, index) => {
            const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber);
            const carrierName = getStandardCarrierName(shipment.carrierCode);
            
            console.log(`Shipment ${index + 1}: ${shipment.carrierCode} -> ${carrierName}, tracking: ${shipment.trackingNumber}, URL: ${trackingUrl}`);
            
            shipments.push({
              shipmentId: shipment.shipmentId,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: trackingUrl,
              carrierCode: shipment.carrierCode,
              carrierName: carrierName,
              shipDate: shipment.shipDate,
              deliveryDate: shipment.deliveryDate || null,
              shipmentNumber: index + 1,
              totalShipments: shipmentData.shipments.length
            });
          });
        }
      } catch (shipmentError) {
        console.log('Could not fetch shipment info:', shipmentError.message);
        // Continue without tracking info rather than failing
      }
    }

    // Format response for frontend
    const response = {
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      orderDate: order.orderDate,
      orderStatus: order.orderStatus.toLowerCase(),
      shipments: shipments
    };

    console.log('Sending response:', JSON.stringify(response, null, 2));

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

// Helper function to make ShipStation V1 API requests
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

    console.log(`Making request to: https://ssapi.shipstation.com${endpoint}`);

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`API Response Status: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (parseError) {
            console.error('JSON parse error:', parseError);
            reject(new Error('Invalid response from ShipStation'));
          }
        } else if (res.statusCode === 401) {
          reject(new Error('Invalid ShipStation API credentials'));
        } else if (res.statusCode === 404) {
          resolve({ orders: [], shipments: [] }); // No data found
        } else {
          console.error(`API Error ${res.statusCode}:`, data);
          reject(new Error(`ShipStation API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('Request error:', error);
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

// Function to generate tracking URLs
function generateTrackingUrl(carrierCode, trackingNumber) {
  if (!trackingNumber || !carrierCode) {
    return null;
  }
  
  const trackingUrls = {
    'ups': `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`,
    'ups_ground': `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`,
    'fedex': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'fedex_express': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'fedex_ground': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'usps': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    'stamps_com': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    'dhl': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    'dhl_express': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    'ontrac': `https://www.ontrac.com/tracking/?number=${trackingNumber}`,
    'lasership': `https://www.lasership.com/track/${trackingNumber}`,
    'amazon': `https://track.amazon.com/tracking/${trackingNumber}`
  };
  
  return trackingUrls[carrierCode.toLowerCase()] || null;
}

// Function to get standardized carrier names
function getStandardCarrierName(carrierCode) {
  if (!carrierCode) return 'CARRIER';
  
  const carrierNames = {
    'ups': 'UPS',
    'ups_ground': 'UPS',
    'fedex': 'FedEx',
    'fedex_express': 'FedEx',
    'fedex_ground': 'FedEx',
    'usps': 'USPS',
    'stamps_com': 'USPS',
    'dhl': 'DHL',
    'dhl_express': 'DHL',
    'ontrac': 'OnTrac',
    'lasership': 'LaserShip',
    'amazon': 'Amazon',
    'newgistics': 'Newgistics'
  };
  
  return carrierNames[carrierCode.toLowerCase()] || carrierCode.toUpperCase();
}