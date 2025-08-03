exports.handler = async (event, context) => {
  // Set longer timeout for Netlify function
  context.callbackWaitsForEmptyEventLoop = false;
  
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
    console.log('=== FUNCTION START ===');
    console.log('Event:', JSON.stringify(event, null, 2));
    
    // Parse request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid request format' })
      };
    }

    const { orderNumber, email } = requestBody;
    console.log(`Processing request for order: ${orderNumber}, email: ${email}`);

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

    console.log(`=== SEARCHING SHIPSTATION ===`);
    console.log(`Query: order=${cleanOrderNumber}, email=${cleanEmail}`);

    // Get order from ShipStation
    const orderData = await makeShipStationRequest(`/orders?${searchParams}`, auth);
    console.log(`ShipStation order response:`, JSON.stringify(orderData, null, 2));

    if (!orderData.orders || orderData.orders.length === 0) {
      console.log('No orders found in ShipStation');
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
      console.log('No exact match found');
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Order not found. Please check your order number and email address and try again.' })
      };
    }

    const order = exactMatch;
    console.log(`=== ORDER FOUND ===`);
    console.log(`Order: ${order.orderNumber}, Status: ${order.orderStatus}`);

    // Get shipments - always check regardless of order status
    let shipments = [];
    let effectiveOrderStatus = order.orderStatus;
    
    try {
      console.log(`=== FETCHING SHIPMENTS ===`);
      const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${cleanOrderNumber}`, auth);
      console.log(`Shipments response:`, JSON.stringify(shipmentData, null, 2));
      
      if (shipmentData.shipments && shipmentData.shipments.length > 0) {
        console.log(`Found ${shipmentData.shipments.length} shipments`);
        
        if (seventeenTrackKey) {
          console.log('=== USING 17TRACK ===');
          
          try {
            const trackedShipments = await getShipmentsWithTracking(
              shipmentData.shipments, 
              seventeenTrackKey
            );
            
            console.log('=== 17TRACK COMPLETE ===');
            console.log(`Tracked shipments:`, JSON.stringify(trackedShipments, null, 2));
            
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
              console.log('📦 All shipments delivered');
            } else if (hasDeliveredShipments) {
              effectiveOrderStatus = 'partially_delivered';
              console.log('📦 Some shipments delivered');
            } else if (hasInTransitShipments) {
              effectiveOrderStatus = 'shipped';
              console.log('📦 Shipments in transit');
            } else if (trackedShipments.length > 0 && !hasActuallyShippedShipments) {
              effectiveOrderStatus = 'awaiting_fulfillment';
              console.log('📦 Labels created but not shipped');
            }
            
          } catch (trackingError) {
            console.error('17track processing failed:', trackingError);
            console.log('Falling back to ShipStation data only');
            
            // Fallback to ShipStation data
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
          // No 17track configured
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
      console.error('Error fetching shipment info:', shipmentError);
      // Continue without tracking info rather than failing
    }

    console.log(`=== FINAL RESULT ===`);
    console.log(`Effective status: ${effectiveOrderStatus}`);
    console.log(`Total shipments: ${shipments.length}`);

    // Format response
    const response = {
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      orderDate: order.orderDate,
      orderStatus: effectiveOrderStatus.toLowerCase(),
      shipments: shipments
    };

    console.log('=== SENDING RESPONSE ===');
    console.log('Response:', JSON.stringify(response, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    console.error('=== FUNCTION ERROR ===');
    console.error('Error details:', error);
    console.error('Stack trace:', error.stack);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Unable to retrieve order information. Please try again.',
        debug: process.env.NODE_ENV === 'development' ? error.message : undefined
      })
    };
  }
};

// Get shipments with tracking - IMPROVED WITH BETTER ERROR HANDLING
async function getShipmentsWithTracking(shipments, apiKey) {
  const trackedShipments = [];
  const maxConcurrent = 2; // Limit concurrent requests
  
  console.log(`\n=== STARTING 17TRACK PROCESSING ===`);
  console.log(`Processing ${shipments.length} shipments (max ${maxConcurrent} concurrent)`);
  
  // Process shipments in smaller batches to avoid overwhelming 17track
  for (let i = 0; i < shipments.length; i += maxConcurrent) {
    const batch = shipments.slice(i, i + maxConcurrent);
    const batchPromises = batch.map(shipment => processSingleShipment(shipment, apiKey));
    
    try {
      const batchResults = await Promise.allSettled(batchPromises);
      
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          trackedShipments.push(result.value);
        } else {
          console.error(`Batch shipment ${i + index} failed:`, result.reason);
          // Add fallback data
          trackedShipments.push({
            ...batch[index],
            actuallyShipped: true, // Assume shipped if we can't verify
            isDelivered: checkShipmentDeliveryStatus(batch[index]),
            trackingStatusCode: 0,
            latestActivity: null
          });
        }
      });
    } catch (error) {
      console.error(`Batch processing failed:`, error);
      // Add all batch items as fallbacks
      batch.forEach(shipment => {
        trackedShipments.push({
          ...shipment,
          actuallyShipped: true,
          isDelivered: checkShipmentDeliveryStatus(shipment),
          trackingStatusCode: 0,
          latestActivity: null
        });
      });
    }
  }
  
  console.log(`=== 17TRACK PROCESSING COMPLETE ===`);
  return trackedShipments;
}

// Process a single shipment with 17track
async function processSingleShipment(shipment, apiKey) {
  if (!shipment.trackingNumber) {
    console.log(`Shipment ${shipment.shipmentId} has no tracking number`);
    return {
      ...shipment,
      actuallyShipped: false,
      isDelivered: false,
      trackingStatusCode: 0,
      latestActivity: null
    };
  }
  
  const startTime = Date.now();
  console.log(`\n--- Processing: ${shipment.trackingNumber} ---`);
  
  try {
    // Step 1: Try to get existing tracking data (with shorter timeout)
    console.log(`Step 1: Getting existing data for ${shipment.trackingNumber}`);
    let trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
      number: shipment.trackingNumber
    }], apiKey, 8000); // 8 second timeout
    
    let trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
    
    // Step 2: If no data, register and poll (but with limits)
    if (!trackInfo || !trackInfo.track || !trackInfo.track.z0 || trackInfo.track.z0.length === 0) {
      console.log(`Step 2: Registering ${shipment.trackingNumber}`);
      
      await makeSeventeenTrackRequest('/register', [{
        number: shipment.trackingNumber
      }], apiKey, 5000); // 5 second timeout for registration
      
      // Step 3: Limited polling (max 2 attempts with shorter waits)
      for (let attempt = 0; attempt < 2; attempt++) {
        console.log(`Step 3: Polling attempt ${attempt + 1} for ${shipment.trackingNumber}`);
        
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second wait
        }
        
        trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
          number: shipment.trackingNumber
        }], apiKey, 6000); // 6 second timeout
        
        trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
        
        if (trackInfo && trackInfo.track && trackInfo.track.z0 && trackInfo.track.z0.length > 0) {
          console.log(`✅ Got data for ${shipment.trackingNumber} on attempt ${attempt + 1}`);
          break;
        }
      }
    }
    
    // Step 4: Process the data
    let actuallyShipped = false;
    let isDelivered = false;
    let deliveryDate = null;
    let latestActivity = null;
    let trackingStatusCode = 0;
    
    if (trackInfo && trackInfo.track) {
      trackingStatusCode = trackInfo.track.e || 0;
      const hasTrackingEvents = trackInfo.track.z0 && trackInfo.track.z0.length > 0;
      
      console.log(`📊 Analysis for ${shipment.trackingNumber}: status=${trackingStatusCode}, events=${hasTrackingEvents}`);
      
      if (hasTrackingEvents) {
        const trackingEvents = trackInfo.track.z0;
        
        // Check for actual movement
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
          const latestEvent = trackingEvents[0];
          latestActivity = {
            status: latestEvent.z || '',
            location: latestEvent.c || '',
            time: latestEvent.a || '',
            description: latestEvent.z || ''
          };
          
          if (latestEvent.z && latestEvent.z.toLowerCase().includes('delivered')) {
            isDelivered = true;
            deliveryDate = latestEvent.a || null;
          }
        }
        
        console.log(`📦 Final: ${shipment.trackingNumber} shipped=${actuallyShipped}, delivered=${isDelivered}`);
      }
    }
    
    const processingTime = Date.now() - startTime;
    console.log(`⏱️ Processed ${shipment.trackingNumber} in ${processingTime}ms`);
    
    return {
      ...shipment,
      actuallyShipped: actuallyShipped,
      isDelivered: isDelivered,
      deliveryDate: deliveryDate || shipment.deliveryDate,
      trackingStatusCode: trackingStatusCode,
      latestActivity: latestActivity
    };
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error(`❌ Failed ${shipment.trackingNumber} after ${processingTime}ms:`, error.message);
    
    // Return fallback data
    return {
      ...shipment,
      actuallyShipped: true, // Assume shipped if we can't verify
      isDelivered: checkShipmentDeliveryStatus(shipment),
      trackingStatusCode: 0,
      latestActivity: null
    };
  }
}

// IMPROVED: 17track API request with configurable timeout
function makeSeventeenTrackRequest(endpoint, data, apiKey, timeoutMs = 10000) {
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
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        console.log(`17track ${endpoint} response: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(responseData);
            resolve(parsedData);
          } catch (parseError) {
            console.error('17track parse error:', responseData);
            reject(new Error('Invalid response from 17track'));
          }
        } else {
          console.error(`17track error ${res.statusCode}:`, responseData);
          reject(new Error(`17track API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('17track request error:', error.message);
      reject(error);
    });
    
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      console.error(`17track timeout after ${timeoutMs}ms`);
      reject(new Error(`17track request timeout (${timeoutMs}ms)`));
    });
    
    req.write(postData);
    req.end();
  });
}

// ShipStation API request function (unchanged)
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

// Helper functions (unchanged)
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

function checkShipmentDeliveryStatus(shipment) {
  if (shipment.deliveryDate) return true;
  if (shipment.voidDate) return false;
  if (shipment.shipmentStatus && shipment.shipmentStatus.toLowerCase() === 'delivered') return true;
  if (shipment.trackingStatus && shipment.trackingStatus.toLowerCase().includes('delivered')) return true;
  return false;
}

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