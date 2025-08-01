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

    // Validate inputs more strictly
    if (!orderNumber || !email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order number and email are required' })
      };
    }

    // Clean and validate inputs
    const cleanOrderNumber = orderNumber.trim();
    const cleanEmail = email.trim();

    if (!cleanOrderNumber || !cleanEmail) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order number and email cannot be empty' })
      };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid email format' })
      };
    }

    // Validate order number format (basic check)
    if (cleanOrderNumber.length < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order number must be at least 3 characters' })
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
    
    // Search for order by number and email (exact matching)
    const searchParams = new URLSearchParams({
      orderNumber: cleanOrderNumber,
      customerEmail: cleanEmail // Keep original case for exact matching
    });

    console.log(`Searching for exact match - Order: "${cleanOrderNumber}", Email: "${cleanEmail}"`);

    // Call ShipStation V1 API for orders
    const orderData = await makeShipStationRequest(`/orders?${searchParams}`, auth);

    if (!orderData.orders || orderData.orders.length === 0) {
      console.log('No orders returned from ShipStation API');
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address and try again.' })
      };
    }

    // Additional validation: Ensure exact match for order number and email
    const exactMatch = orderData.orders.find(order => {
      const orderMatches = order.orderNumber === cleanOrderNumber;
      const emailMatches = order.customerEmail.toLowerCase() === cleanEmail.toLowerCase();
      
      console.log(`Checking order ${order.orderNumber}:`);
      console.log(`  - Order number match: ${orderMatches} (${order.orderNumber} === ${cleanOrderNumber})`);
      console.log(`  - Email match: ${emailMatches} (${order.customerEmail.toLowerCase()} === ${cleanEmail.toLowerCase()})`);
      
      return orderMatches && emailMatches;
    });

    if (!exactMatch) {
      console.log('No exact match found in returned orders');
      console.log('Available orders:', orderData.orders.map(o => ({
        orderNumber: o.orderNumber,
        customerEmail: o.customerEmail
      })));
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address and try again.' })
      };
    }

    // Use the exact match
    const order = exactMatch;
    console.log(`Found order: ${order.orderNumber} with status: ${order.orderStatus}`);

    // Get tracking information for any order that has shipping activity
    let shipments = [];
    if (order.orderStatus === 'shipped' || order.orderStatus === 'delivered' || order.orderStatus === 'awaiting_shipment') {
      try {
        console.log(`Fetching shipments for order: ${cleanOrderNumber}`);
        const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${cleanOrderNumber}`, auth);
        
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          console.log(`Found ${shipmentData.shipments.length} shipments`);
          
          // Process each shipment and check individual delivery status
          shipmentData.shipments.forEach((shipment, index) => {
            const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber);
            const carrierName = getStandardCarrierName(shipment.carrierCode);
            
            // Check if this individual shipment is delivered
            const isDelivered = checkShipmentDeliveryStatus(shipment);
            
            console.log(`Shipment ${index + 1}: ${shipment.carrierCode} -> ${carrierName}`);
            console.log(`  - Tracking: ${shipment.trackingNumber}`);
            console.log(`  - URL: ${trackingUrl}`);
            console.log(`  - Ship Date: ${shipment.shipDate}`);
            console.log(`  - Delivery Status: ${isDelivered ? 'Delivered' : 'In Transit'}`);
            console.log(`  - Shipment Details:`, JSON.stringify(shipment, null, 2));
            
            shipments.push({
              shipmentId: shipment.shipmentId,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: trackingUrl,
              carrierCode: shipment.carrierCode,
              carrierName: carrierName,
              shipDate: shipment.shipDate,
              deliveryDate: shipment.deliveryDate || null,
              isDelivered: isDelivered,
              shipmentNumber: index + 1,
              totalShipments: shipmentData.shipments.length
            });
          });
        } else {
          console.log('No shipments found for this order');
        }
      } catch (shipmentError) {
        console.log('Could not fetch shipment info:', shipmentError.message);
        // Continue without tracking info rather than failing
      }
    } else {
      console.log(`Order status is '${order.orderStatus}', not checking for shipments`);
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
          console.error('Authentication failed - check API credentials');
          reject(new Error('Invalid ShipStation API credentials'));
        } else if (res.statusCode === 403) {
          console.error('Access forbidden - check API permissions');
          reject(new Error('Access denied by ShipStation API'));
        } else if (res.statusCode === 404) {
          console.log('No data found for request');
          resolve({ orders: [], shipments: [] }); // No data found
        } else if (res.statusCode === 429) {
          console.error('Rate limit exceeded');
          reject(new Error('Too many requests - please try again later'));
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

// Function to check if a shipment is delivered
function checkShipmentDeliveryStatus(shipment) {
  // Check various fields that might indicate delivery
  if (shipment.deliveryDate) {
    return true;
  }
  
  // Check if void date exists (might indicate cancellation, not delivery)
  if (shipment.voidDate) {
    return false;
  }
  
  // Check shipment status if available
  if (shipment.shipmentStatus && shipment.shipmentStatus.toLowerCase() === 'delivered') {
    return true;
  }
  
  // Check tracking status if available
  if (shipment.trackingStatus && shipment.trackingStatus.toLowerCase().includes('delivered')) {
    return true;
  }
  
  // Default to not delivered if we can't determine
  return false;
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