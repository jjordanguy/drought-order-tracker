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

    if (cleanOrderNumber.length < 3) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Order number must be at least 3 characters' })
      };
    }

    // Get API credentials
    const apiKey = process.env.SHIPSTATION_API_KEY;
    const apiSecret = process.env.SHIPSTATION_API_SECRET;
    const seventeenTrackKey = process.env.SEVENTEEN_TRACK_API_KEY;

    if (!apiKey || !apiSecret) {
      console.error('Missing ShipStation API credentials');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server configuration error' })
      };
    }

    console.log('17track API Key configured:', seventeenTrackKey ? 'YES' : 'NO');

    // Create auth header for ShipStation
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    // Search for order
    const searchParams = new URLSearchParams({
      orderNumber: cleanOrderNumber,
      customerEmail: cleanEmail
    });

    console.log(`Searching for order: "${cleanOrderNumber}", Email: "${cleanEmail}"`);

    // Get order from ShipStation
    const orderData = await makeShipStationRequest(`/orders?${searchParams}`, auth);

    if (!orderData.orders || orderData.orders.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address and try again.' })
      };
    }

    // Find exact match
    const exactMatch = orderData.orders.find(order => {
      const orderMatches = order.orderNumber === cleanOrderNumber;
      const emailMatches = order.customerEmail.toLowerCase() === cleanEmail.toLowerCase();
      return orderMatches && emailMatches;
    });

    if (!exactMatch) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address and try again.' })
      };
    }

    const order = exactMatch;
    console.log(`Found order: ${order.orderNumber} with ShipStation status: ${order.orderStatus}`);

    // Get shipments - always check regardless of order status
    let shipments = [];
    let effectiveOrderStatus = order.orderStatus;
    
    try {
      console.log(`Fetching shipments for order: ${cleanOrderNumber}`);
      const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${cleanOrderNumber}`, auth);
      
      if (shipmentData.shipments && shipmentData.shipments.length > 0) {
        console.log(`Found ${shipmentData.shipments.length} shipments`);
        
        if (seventeenTrackKey) {
          console.log('=== Using 17track for tracking status ===');
          
          const trackedShipments = await getShipmentsWithTracking(
            shipmentData.shipments, 
            seventeenTrackKey
          );
          
          // Process shipments and determine overall order status
          let hasDeliveredShipments = false;
          let hasInTransitShipments = false;
          let hasActuallyShippedShipments = false;
          
          trackedShipments.forEach((shipment, index) => {
            const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber);
            const carrierName = getStandardCarrierName(shipment.carrierCode);
            
            // Determine shipment status from 17track
            let shipmentStatus = 'processing';
            if (shipment.isDelivered) {
              shipmentStatus = 'delivered';
              hasDeliveredShipments = true;
            } else if (shipment.actuallyShipped) {
              shipmentStatus = 'shipped';
              hasInTransitShipments = true;
              hasActuallyShippedShipments = true;
            }
            
            shipments.push({
              shipmentId: shipment.shipmentId,
              trackingNumber: shipment.trackingNumber,
              trackingUrl: trackingUrl,
              carrierCode: shipment.carrierCode,
              carrierName: carrierName,
              shipDate: shipment.shipDate,
              deliveryDate: shipment.deliveryDate || null,
              isDelivered: shipment.isDelivered,
              shipmentNumber: index + 1,
              totalShipments: trackedShipments.length,
              latestActivity: shipment.latestActivity || null,
              items: shipment.shipmentItems || [],
              status: shipmentStatus,
              trackingStatus: shipment.trackingStatusCode || 0
            });
          });
          
          // Determine overall order status based on 17track data
          if (hasDeliveredShipments && trackedShipments.every(s => s.isDelivered)) {
            effectiveOrderStatus = 'delivered';
            console.log('📦 All shipments delivered - order status: delivered');
          } else if (hasDeliveredShipments) {
            effectiveOrderStatus = 'partially_delivered';
            console.log('📦 Some shipments delivered - order status: partially_delivered');
          } else if (hasInTransitShipments) {
            effectiveOrderStatus = 'shipped';
            console.log('📦 Shipments in transit - order status: shipped');
          } else if (trackedShipments.length > 0 && !hasActuallyShippedShipments) {
            effectiveOrderStatus = 'awaiting_fulfillment';
            console.log('📦 Labels created but not shipped - order status: awaiting_fulfillment');
          }
          
        } else {
          // Fallback without 17track
          console.log('17track not configured, using ShipStation data only');
          
          shipmentData.shipments.forEach((shipment, index) => {
            const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber);
            const carrierName = getStandardCarrierName(shipment.carrierCode);
            const isDelivered = checkShipmentDeliveryStatus(shipment);
            
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
              totalShipments: shipmentData.shipments.length,
              items: shipment.shipmentItems || []
            });
          });
        }
      } else {
        console.log('No shipments found for this order');
      }
    } catch (shipmentError) {
      console.log('Error fetching shipment info:', shipmentError.message);
    }

    console.log(`\n=== FINAL STATUS DETERMINATION ===`);
    console.log(`ShipStation status: ${order.orderStatus}`);
    console.log(`Effective status (with tracking): ${effectiveOrderStatus}`);
    console.log(`Total shipments: ${shipments.length}`);

    // Format response
    const response = {
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      orderDate: order.orderDate,
      orderStatus: effectiveOrderStatus.toLowerCase(),
      shipments: shipments
    };

    console.log('Sending response with effective status:', effectiveOrderStatus);

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

// Get shipments with full tracking information from 17track
async function getShipmentsWithTracking(shipments, apiKey) {
  const trackedShipments = [];
  
  console.log(`\n=== GETTING TRACKING DATA FOR ${shipments.length} SHIPMENTS ===`);
  
  for (const shipment of shipments) {
    if (!shipment.trackingNumber) {
      console.log(`Shipment ${shipment.shipmentId} has no tracking number`);
      trackedShipments.push({
        ...shipment,
        actuallyShipped: false,
        isDelivered: false,
        trackingStatusCode: 0,
        latestActivity: null
      });
      continue;
    }
    
    try {
      console.log(`\n--- Getting tracking for: ${shipment.trackingNumber} ---`);
      
      // Try to get existing tracking data first
      let trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
        number: shipment.trackingNumber
      }], apiKey);
      
      let trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
      
      // If no data, register and wait
      if (!trackInfo || !trackInfo.track || !trackInfo.track.z0 || trackInfo.track.z0.length === 0) {
        console.log(`Registering ${shipment.trackingNumber} with 17track...`);
        
        await makeSeventeenTrackRequest('/register', [{
          number: shipment.trackingNumber
        }], apiKey);
        
        // Wait and retry
        for (let attempt = 0; attempt < 3; attempt++) {
          console.log(`Attempt ${attempt + 1} to get tracking data...`);
          
          if (attempt > 0) {
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
          
          trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
            number: shipment.trackingNumber
          }], apiKey);
          
          trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
          
          if (trackInfo && trackInfo.track && trackInfo.track.z0 && trackInfo.track.z0.length > 0) {
            console.log(`Got tracking data on attempt ${attempt + 1}`);
            break;
          }
        }
      }
      
      // Process tracking data and determine status
      let actuallyShipped = false;
      let isDelivered = false;
      let deliveryDate = null;
      let latestActivity = null;
      let trackingStatusCode = 0;
      
      if (trackInfo && trackInfo.track) {
        trackingStatusCode = trackInfo.track.e || 0;
        const hasTrackingEvents = trackInfo.track.z0 && trackInfo.track.z0.length > 0;
        
        console.log(`Tracking status code: ${trackingStatusCode}`);
        console.log(`Has tracking events: ${hasTrackingEvents}`);
        
        // 17track status codes:
        // 0 = Not Found/No Info
        // 10 = In Transit  
        // 20 = Expired
        // 30 = Pickup
        // 35 = Undelivered  
        // 40 = Delivered
        // 50 = Alert/Exception
        
        if (hasTrackingEvents) {
          // Look for movement beyond just label creation
          const trackingEvents = trackInfo.track.z0;
          
          // Check for actual movement indicators
          const hasMovement = trackingEvents.some(event => {
            const eventText = (event.z || '').toLowerCase();
            return eventText.includes('picked up') || 
                   eventText.includes('in transit') || 
                   eventText.includes('out for delivery') ||
                   eventText.includes('delivered') ||
                   eventText.includes('departed') ||
                   eventText.includes('arrived') ||
                   trackingStatusCode >= 10;
          });
          
          actuallyShipped = hasMovement || trackingStatusCode >= 10;
          isDelivered = trackingStatusCode === 40;
          
          // Get latest activity
          if (trackingEvents.length > 0) {
            const latestEvent = trackingEvents[0]; // Most recent first
            latestActivity = {
              status: latestEvent.z || '',
              location: latestEvent.c || '',
              time: latestEvent.a || '',
              description: latestEvent.z || ''
            };
            
            // Check if this event indicates delivery
            if (latestEvent.z && latestEvent.z.toLowerCase().includes('delivered')) {
              isDelivered = true;
              deliveryDate = latestEvent.a || null;
            }
          }
          
          console.log(`Final status: shipped=${actuallyShipped}, delivered=${isDelivered}, code=${trackingStatusCode}`);
        }
      }
      
      trackedShipments.push({
        ...shipment,
        actuallyShipped: actuallyShipped,
        isDelivered: isDelivered,
        deliveryDate: deliveryDate || shipment.deliveryDate,
        trackingStatusCode: trackingStatusCode,
        latestActivity: latestActivity
      });
      
    } catch (error) {
      console.error(`Failed to get tracking for ${shipment.trackingNumber}:`, error.message);
      
      // Fallback to ShipStation data
      trackedShipments.push({
        ...shipment,
        actuallyShipped: true,
        isDelivered: checkShipmentDeliveryStatus(shipment),
        trackingStatusCode: 0,
        latestActivity: null
      });
    }
  }
  
  return trackedShipments;
}

// Helper function to make 17track API requests
function makeSeventeenTrackRequest(endpoint, data, apiKey) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'api.17track.net',
      path: `/track/v2.2${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        '17token': apiKey
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
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (parseError) {
            reject(new Error('Invalid response from 17track'));
          }
        } else {
          reject(new Error(`17track API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('17track request timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

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
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (parseError) {
            reject(new Error('Invalid response from ShipStation'));
          }
        } else if (res.statusCode === 404) {
          resolve({ orders: [], shipments: [] });
        } else {
          reject(new Error(`ShipStation API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Network error: ${error.message}`));
    });

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

// Function to check if a shipment is delivered (ShipStation fallback)
function checkShipmentDeliveryStatus(shipment) {
  if (shipment.deliveryDate) return true;
  if (shipment.voidDate) return false;
  if (shipment.shipmentStatus && shipment.shipmentStatus.toLowerCase() === 'delivered') return true;
  if (shipment.trackingStatus && shipment.trackingStatus.toLowerCase().includes('delivered')) return true;
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