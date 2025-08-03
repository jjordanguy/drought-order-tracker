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
    
    // Get order from ShipStation
    const orderData = await makeShipStationRequest(`/orders?${searchParams}`, auth);

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
      
      if (shipmentData.shipments && shipmentData.shipments.length > 0) {
        console.log(`Found ${shipmentData.shipments.length} shipments`);
        
        if (seventeenTrackKey) {
          console.log('=== USING 17TRACK V2.2 ===');
          
          try {
            const trackedShipments = await getShipmentsWithTracking(
              shipmentData.shipments, 
              seventeenTrackKey
            );
            
            console.log('=== 17TRACK V2.2 COMPLETE ===');
            
            // Process shipments and determine overall order status
            let hasDeliveredShipments = false;
            let hasInTransitShipments = false;
            let hasActuallyShippedShipments = false;
            
            trackedShipments.forEach((shipment, index) => {
              const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber, shipment.carrier17trackName);
              const carrierName = getStandardCarrierName(shipment.carrierCode, shipment.carrier17trackName);
              
              // Determine shipment status from 17track v2.2 data
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
                trackingStatus: shipment.trackingStatus || ''
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

// CORRECTED: 17track v2.2 implementation
async function getShipmentsWithTracking(shipments, apiKey) {
  const trackedShipments = [];
  
  console.log(`\n=== STARTING 17TRACK V2.2 PROCESSING ===`);
  console.log(`Processing ${shipments.length} shipments`);
  
  for (const shipment of shipments) {
    if (!shipment.trackingNumber) {
      console.log(`Shipment ${shipment.shipmentId} has no tracking number`);
      trackedShipments.push({
        ...shipment,
        actuallyShipped: false,
        isDelivered: false,
        trackingStatus: '',
        latestActivity: null
      });
      continue;
    }
    
    try {
      console.log(`\n--- Processing: ${shipment.trackingNumber} ---`);
      
      // Step 1: Try to get existing tracking data
      console.log(`Step 1: Getting existing data for ${shipment.trackingNumber}`);
      let trackingData = await makeSeventeenTrackV22Request('/gettrackinfo', [{
        number: shipment.trackingNumber
        // NO carrier - let it auto-detect
      }], apiKey);
      
      // Check if we got data - CORRECTED: latest_status is inside track_info
      let hasValidData = false;
      if (trackingData && trackingData.data && trackingData.data.accepted && trackingData.data.accepted.length > 0) {
        const acceptedData = trackingData.data.accepted[0];
        // Check if we have actual tracking info (not just registration)
        hasValidData = acceptedData.track_info && 
                      acceptedData.track_info.latest_status && 
                      acceptedData.track_info.latest_status.status;
        
        if (hasValidData) {
          console.log(`✅ Found valid tracking data: ${acceptedData.track_info.latest_status.status}`);
        }
      }
      
      // Step 2: If no data, register and wait
      if (!hasValidData) {
        console.log(`Step 2: Registering ${shipment.trackingNumber} with 17track v2.2`);
        
        const registerResponse = await makeSeventeenTrackV22Request('/register', [{
          number: shipment.trackingNumber
          // NO carrier - let it auto-detect (80% success rate)
        }], apiKey);
        
        console.log(`Register response:`, JSON.stringify(registerResponse, null, 2));
        
        // Check if registration was successful
        if (registerResponse && registerResponse.data && registerResponse.data.accepted && registerResponse.data.accepted.length > 0) {
          console.log(`✅ Registration successful for ${shipment.trackingNumber}`);
          
          // Step 3: Wait and retry to get tracking data
          for (let attempt = 0; attempt < 3; attempt++) {
            console.log(`Step 3: Polling attempt ${attempt + 1} for ${shipment.trackingNumber}`);
            
            if (attempt > 0) {
              await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second wait
            }
            
            trackingData = await makeSeventeenTrackV22Request('/gettrackinfo', [{
              number: shipment.trackingNumber
            }], apiKey);
            
            console.log(`Attempt ${attempt + 1} response:`, JSON.stringify(trackingData, null, 2));
            
            if (trackingData && trackingData.data && trackingData.data.accepted && trackingData.data.accepted.length > 0) {
              const acceptedData = trackingData.data.accepted[0];
              if (acceptedData.track_info && acceptedData.track_info.latest_status && acceptedData.track_info.latest_status.status) {
                console.log(`✅ Got tracking data for ${shipment.trackingNumber} on attempt ${attempt + 1}`);
                hasValidData = true;
                break;
              }
            }
          }
        } else {
          console.log(`❌ Registration failed for ${shipment.trackingNumber}`);
          if (registerResponse && registerResponse.data && registerResponse.data.rejected && registerResponse.data.rejected.length > 0) {
            console.log(`Rejection reason:`, registerResponse.data.rejected[0]);
          }
        }
      } else {
        console.log(`✅ Found existing data for ${shipment.trackingNumber}`);
      }
      
      // Step 4: Process the tracking data using v2.2 format - CORRECTED PATHS
      let actuallyShipped = false;
      let isDelivered = false;
      let deliveryDate = null;
      let latestActivity = null;
      let trackingStatus = '';
      
      if (hasValidData && trackingData.data.accepted.length > 0) {
        const acceptedData = trackingData.data.accepted[0];
        
        console.log(`📊 v2.2 Analysis for ${shipment.trackingNumber}:`);
        console.log(`Track Info:`, JSON.stringify(acceptedData.track_info, null, 2));
        
        if (acceptedData.track_info && acceptedData.track_info.latest_status) {
          const latestStatus = acceptedData.track_info.latest_status;
          trackingStatus = latestStatus.status || '';
          const subStatus = latestStatus.sub_status || '';
          
          console.log(`Status: "${trackingStatus}", Sub-status: "${subStatus}"`);
          
          // v2.2 Status interpretation based on documentation
          switch (trackingStatus.toLowerCase()) {
            case 'delivered':
              actuallyShipped = true;
              isDelivered = true;
              // Get delivery date from latest_event
              if (acceptedData.track_info.latest_event && acceptedData.track_info.latest_event.time_iso) {
                deliveryDate = acceptedData.track_info.latest_event.time_iso;
              }
              break;
              
            case 'intransit':
            case 'in_transit':
              actuallyShipped = true;
              isDelivered = false;
              break;
              
            case 'pickup':
            case 'picked_up':
              actuallyShipped = true;
              isDelivered = false;
              break;
              
            case 'undelivered':
            case 'exception':
            case 'alert':
              actuallyShipped = true; // Package was moving but had issues
              isDelivered = false;
              break;
              
            case 'pending':
            case 'info_received':
            case 'inforeceived':
            case 'not_found':
            default:
              actuallyShipped = false;
              isDelivered = false;
              break;
          }
          
          // Get latest activity from latest_event
          if (acceptedData.track_info.latest_event) {
            const latestEvent = acceptedData.track_info.latest_event;
            latestActivity = {
              status: latestEvent.description || trackingStatus,
              location: latestEvent.location || '',
              time: latestEvent.time_iso || latestEvent.time_utc || '',
              description: latestEvent.description || trackingStatus
            };
          } else {
            // Fallback to latest_status
            latestActivity = {
              status: trackingStatus,
              location: '',
              time: '',
              description: trackingStatus
            };
          }
          
          // Special handling for sub-status
          if (subStatus.toLowerCase().includes('pickedup') || subStatus.toLowerCase().includes('picked_up')) {
            actuallyShipped = true;
          }
          
          console.log(`📦 Final v2.2 result: ${shipment.trackingNumber} shipped=${actuallyShipped}, delivered=${isDelivered}, status="${trackingStatus}"`);
        } else {
          console.log(`❌ No track_info.latest_status found for ${shipment.trackingNumber}`);
        }
      }
      
      trackedShipments.push({
        ...shipment,
        actuallyShipped: actuallyShipped,
        isDelivered: isDelivered,
        deliveryDate: deliveryDate || shipment.deliveryDate,
        trackingStatus: trackingStatus,
        latestActivity: latestActivity,
        carrier17trackName: get17trackCarrierName(trackingData) // Add 17track carrier name
      });
      
    } catch (error) {
      console.error(`❌ Failed ${shipment.trackingNumber}:`, error.message);
      
      // Return fallback data
      trackedShipments.push({
        ...shipment,
        actuallyShipped: true, // Assume shipped if we can't verify
        isDelivered: checkShipmentDeliveryStatus(shipment),
        trackingStatus: 'error',
        latestActivity: null
      });
    }
  }
  
  console.log(`=== 17TRACK V2.2 PROCESSING COMPLETE ===`);
  return trackedShipments;
}

// CORRECTED: 17track v2.2 API request function
function makeSeventeenTrackV22Request(endpoint, data, apiKey) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: 'api.17track.net',
      path: `/track/v2.2${endpoint}`, // v2.2 path
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        '17token': apiKey
      }
    };
    
    console.log(`🌐 17track v2.2 API request: ${endpoint}`);
    console.log(`URL: https://${options.hostname}${options.path}`);
    console.log(`Body:`, postData);
    
    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        console.log(`📥 17track v2.2 response: ${res.statusCode}`);
        console.log(`📥 Response body:`, responseData);
        
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(responseData);
            resolve(parsedData);
          } catch (parseError) {
            console.error('17track v2.2 parse error:', responseData);
            reject(new Error('Invalid response from 17track v2.2'));
          }
        } else {
          console.error(`17track v2.2 error ${res.statusCode}:`, responseData);
          reject(new Error(`17track v2.2 API error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('17track v2.2 request error:', error.message);
      reject(error);
    });
    
    req.setTimeout(15000, () => {
      req.destroy();
      console.error('17track v2.2 timeout');
      reject(new Error('17track v2.2 request timeout'));
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

// Helper function to extract carrier name from 17track response
function get17trackCarrierName(trackingData) {
  if (!trackingData || !trackingData.data || !trackingData.data.accepted || trackingData.data.accepted.length === 0) {
    return null;
  }
  
  const acceptedData = trackingData.data.accepted[0];
  
  // Try to get carrier name from tracking providers
  if (acceptedData.track_info && 
      acceptedData.track_info.tracking && 
      acceptedData.track_info.tracking.providers && 
      acceptedData.track_info.tracking.providers.length > 0) {
    
    const provider = acceptedData.track_info.tracking.providers[0].provider;
    return provider.name || provider.alias || null;
  }
  
  return null;
}

// UPDATED: Function to generate tracking URLs (handles 17track carrier names)  
function generateTrackingUrl(carrierCode, trackingNumber, carrier17trackName = null) {
  if (!trackingNumber) {
    return null;
  }
  
  // Determine the carrier for URL generation
  let carrierForUrl = carrierCode;
  
  // If we have 17track carrier name, use it to determine the right URL
  if (carrier17trackName) {
    const name = carrier17trackName.toLowerCase();
    if (name.includes('ups')) carrierForUrl = 'ups';
    else if (name.includes('fedex')) carrierForUrl = 'fedex';
    else if (name.includes('usps')) carrierForUrl = 'usps';
    else if (name.includes('dhl')) carrierForUrl = 'dhl';
    else if (name.includes('ontrac')) carrierForUrl = 'ontrac';
    else if (name.includes('lasership')) carrierForUrl = 'lasership';
    else if (name.includes('amazon')) carrierForUrl = 'amazon';
  }
  
  if (!carrierForUrl) {
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
  
  return trackingUrls[carrierForUrl.toLowerCase()] || null;
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