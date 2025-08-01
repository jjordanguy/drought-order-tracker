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

    // Get ShipStation API credentials (use V1 for order lookup)
    const apiKey = process.env.SHIPSTATION_API_KEY;
    const apiSecret = process.env.SHIPSTATION_API_SECRET;
    const v2ApiKey = process.env.SHIPSTATION_PRODUCTION_KEY;

    if (!apiKey || !apiSecret) {
      console.error('Missing ShipStation V1 API credentials');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error' })
      };
    }

    // Create auth header for ShipStation V1
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    // Search for order by number and email using V1 API (more reliable for order lookup)
    const searchParams = new URLSearchParams({
      orderNumber: orderNumber.trim(),
      customerEmail: email.trim().toLowerCase()
    });

    // Call ShipStation V1 API for orders
    const orderData = await makeShipStationV1Request(`/orders?${searchParams}`, auth);

    if (!orderData.orders || orderData.orders.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address.' })
      };
    }

    // Get the matching order
    const order = orderData.orders[0];

    // Get all shipments for this order using V1 API
    let shipments = [];
    if (order.orderStatus === 'shipped' || order.orderStatus === 'delivered') {
      try {
        const shipmentData = await makeShipStationV1Request(`/shipments?orderNumber=${orderNumber.trim()}`, auth);
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          // For each shipment, try to get tracking URL from V2 API if available
          for (let i = 0; i < shipmentData.shipments.length; i++) {
            const shipment = shipmentData.shipments[i];
            let trackingUrl = null;
            
            // Try to get tracking URL from V2 API if we have the key
            if (v2ApiKey && shipment.trackingNumber) {
              try {
                trackingUrl = await getTrackingUrlFromV2(shipment.trackingNumber, v2ApiKey);
              } catch (v2Error) {
                console.log('Could not fetch V2 tracking URL:', v2Error.message);
                // Fallback to manual URL construction
                trackingUrl = getTrackingUrlFallback(shipment.carrierCode, shipment.trackingNumber);
              }
            } else {
              // Fallback to manual URL construction
              trackingUrl = getTrackingUrlFallback(shipment.carrierCode, shipment.trackingNumber);
            }

            console.log(`Shipment ${i + 1}: Carrier=${shipment.carrierCode}, Tracking=${shipment.trackingNumber}, URL=${trackingUrl}`);

            shipments.push({
              shipmentId: shipment.shipmentId,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: trackingUrl,
              carrierCode: shipment.carrierCode,
              carrierName: standardizeCarrierName(shipment.carrierCode),
              shipDate: shipment.shipDate,
              deliveryDate: shipment.deliveryDate || null,
              shipmentNumber: i + 1,
              totalShipments: shipmentData.shipments.length
            });
          }
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
      shipments: shipments
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

// Helper function to make ShipStation V1 API requests
function makeShipStationV1Request(endpoint, auth) {
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

// Helper function to get tracking URL from V2 API labels endpoint
async function getTrackingUrlFromV2(trackingNumber, v2ApiKey) {
  // This would require finding the label by tracking number in V2 API
  // For now, return null and use fallback
  return null;
}

// Fallback function to construct tracking URLs manually
function getTrackingUrlFallback(carrierCode, trackingNumber) {
  if (!trackingNumber) return null;
  
  const carriers = {
    'ups': `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`,
    'fedex': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'usps': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    'dhl': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    'stamps_com': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    'dhl_express': `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
    'fedex_express': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'fedex_ground': `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    'ups_ground': `https://www.ups.com/track?track=yes&trackNums=${trackingNumber}`
  };
  
  return carriers[carrierCode?.toLowerCase()] || null;
}

// Function to standardize carrier names
function standardizeCarrierName(carrierCode) {
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
  
  return carrierNames[carrierCode?.toLowerCase()] || carrierCode?.toUpperCase() || 'CARRIER';
}