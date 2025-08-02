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

    // Get 17track API key
    const seventeenTrackKey = process.env.SEVENTEEN_TRACK_API_KEY;
    console.log('17track API Key configured:', seventeenTrackKey ? 'YES' : 'NO');
    if (!seventeenTrackKey) {
      console.error('Missing 17track API key - tracking verification will be skipped');
    } else {
      console.log('17track API Key length:', seventeenTrackKey.length);
      console.log('17track API Key prefix:', seventeenTrackKey.substring(0, 3) + '***');
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
    console.log(`\n=== ORDER FOUND ===`);
    console.log(`Order Number: ${order.orderNumber}`);
    console.log(`Order Status: ${order.orderStatus}`);
    console.log(`Order Date: ${order.orderDate}`);
    console.log(`Customer Email: ${order.customerEmail}`);
    console.log(`Raw Order Object:`, JSON.stringify(order, null, 2));

    // Get tracking information - ALWAYS CHECK FOR SHIPMENTS REGARDLESS OF STATUS
    let shipments = [];
    let actuallyShippedCount = 0;
    let totalShipmentCount = 0;
    
    console.log(`\n=== CHECKING FOR SHIPMENTS ===`);
    console.log(`Order status: '${order.orderStatus}'`);
    
    // MODIFIED: Check for shipments regardless of order status for debugging
    const shouldCheckShipments = true; // Always check for debugging
    
    if (shouldCheckShipments) {
      console.log(`✅ Will check for shipments (status: ${order.orderStatus})`);
      
      try {
        console.log(`Fetching shipments for order: ${cleanOrderNumber}`);
        const shipmentData = await makeShipStationRequest(`/shipments?orderNumber=${cleanOrderNumber}`, auth);
        
        console.log(`\n=== SHIPSTATION SHIPMENTS RESPONSE ===`);
        console.log(`Shipments found: ${shipmentData.shipments ? shipmentData.shipments.length : 0}`);
        console.log(`Raw shipment data:`, JSON.stringify(shipmentData, null, 2));
        
        if (shipmentData.shipments && shipmentData.shipments.length > 0) {
          console.log(`Found ${shipmentData.shipments.length} shipments`);
          totalShipmentCount = shipmentData.shipments.length;
          
          // Log each shipment's details
          shipmentData.shipments.forEach((shipment, index) => {
            console.log(`\n--- Shipment ${index + 1} ---`);
            console.log(`Shipment ID: ${shipment.shipmentId}`);
            console.log(`Tracking Number: ${shipment.trackingNumber}`);
            console.log(`Carrier Code: ${shipment.carrierCode}`);
            console.log(`Ship Date: ${shipment.shipDate}`);
            console.log(`Delivery Date: ${shipment.deliveryDate}`);
            console.log(`Void Date: ${shipment.voidDate}`);
            console.log(`Items:`, shipment.shipmentItems ? shipment.shipmentItems.length : 0);
          });
          
          // If 17track is available, verify shipments
          if (seventeenTrackKey) {
            console.log('\n=== Starting 17track verification ===');
            console.log(`Total shipments to verify: ${shipmentData.shipments.length}`);
            
            const verifiedShipments = await verifyShipmentsWithSeventeenTrack(
              shipmentData.shipments, 
              seventeenTrackKey
            );
            
            console.log('\n=== 17track verification results ===');
            verifiedShipments.forEach((shipment, index) => {
              console.log(`Shipment ${index + 1}: actuallyShipped=${shipment.actuallyShipped}, status=${shipment.seventeenTrackStatus}`);
            });
            
            console.log(`Shipments actually shipped: ${verifiedShipments.filter(s => s.actuallyShipped).length}`);
            console.log(`Shipments not yet shipped: ${verifiedShipments.filter(s => !s.actuallyShipped).length}`);
            
            // Include ALL shipments for debugging (not just actually shipped ones)
            verifiedShipments.forEach((shipment, index) => {
              actuallyShippedCount++;
              const trackingUrl = generateTrackingUrl(shipment.carrierCode, shipment.trackingNumber);
              const carrierName = getStandardCarrierName(shipment.carrierCode);
              
              shipments.push({
                shipmentId: shipment.shipmentId,
                trackingNumber: shipment.trackingNumber,
                trackingUrl: trackingUrl,
                carrierCode: shipment.carrierCode,
                carrierName: carrierName,
                shipDate: shipment.shipDate,
                deliveryDate: shipment.deliveryDate || null,
                isDelivered: shipment.isDelivered,
                shipmentNumber: actuallyShippedCount,
                totalShipments: actuallyShippedCount,
                latestActivity: shipment.latestActivity || null,
                items: shipment.shipmentItems || [],
                // Debug fields
                actuallyShipped: shipment.actuallyShipped,
                seventeenTrackStatus: shipment.seventeenTrackStatus
              });
            });
            
            // Update total shipments count for display
            shipments.forEach(s => {
              s.totalShipments = actuallyShippedCount;
            });
            
          } else {
            // Fallback to original behavior if 17track not configured
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
          console.log('❌ No shipments found for this order in ShipStation');
        }
      } catch (shipmentError) {
        console.log('❌ Error fetching shipment info:', shipmentError.message);
        console.log('Full error:', shipmentError);
        // Continue without tracking info rather than failing
      }
    } else {
      console.log(`❌ Skipping shipment check due to order status: '${order.orderStatus}'`);
    }

    console.log('\n=== FINAL SHIPMENT SUMMARY ===');
    console.log(`Order status from ShipStation: ${order.orderStatus}`);
    console.log(`Total shipments found: ${totalShipmentCount}`);
    console.log(`Shipments in final array: ${shipments.length}`);
    console.log(`Final shipments array:`, JSON.stringify(shipments, null, 2));

    // For debugging, don't override status - keep original
    const effectiveOrderStatus = order.orderStatus;
    
    console.log('\n=== FINAL RESPONSE PREPARATION ===');
    console.log(`Effective order status: ${effectiveOrderStatus}`);

    // Format response for frontend
    const response = {
      orderNumber: order.orderNumber,
      customerEmail: order.customerEmail,
      orderDate: order.orderDate,
      orderStatus: effectiveOrderStatus.toLowerCase(),
      shipments: shipments,
      // Debug info
      debug: {
        originalOrderStatus: order.orderStatus,
        totalShipmentsFound: totalShipmentCount,
        shipmentsInResponse: shipments.length,
        seventeenTrackEnabled: !!seventeenTrackKey
      }
    };

    console.log('\n=== SENDING RESPONSE ===');
    console.log('Response object:', JSON.stringify(response, null, 2));

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

// Helper function to verify shipments with 17track - WITH ENHANCED DEBUGGING
async function verifyShipmentsWithSeventeenTrack(shipments, apiKey) {
  const verifiedShipments = [];
  
  console.log(`\n=== 17TRACK VERIFICATION START ===`);
  console.log(`Processing ${shipments.length} shipments`);
  
  for (const shipment of shipments) {
    console.log(`\n--- Processing shipment: ${shipment.trackingNumber} ---`);
    
    if (!shipment.trackingNumber) {
      console.log(`❌ Shipment ${shipment.shipmentId} has no tracking number, skipping`);
      verifiedShipments.push({
        ...shipment,
        actuallyShipped: false,
        seventeenTrackStatus: 'no_tracking_number',
        latestActivity: null
      });
      continue;
    }
    
    try {
      console.log(`🔍 Processing tracking ${shipment.trackingNumber} with 17track`);
      
      // First, try to get existing tracking info (in case it's already tracked)
      let trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
        number: shipment.trackingNumber
      }], apiKey);
      
      console.log(`📥 Initial 17track response for ${shipment.trackingNumber}:`);
      console.log(JSON.stringify(trackingData, null, 2));
      
      // Check if we got valid tracking data
      let trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
      
      // If no data or no tracking events, try to register and wait
      if (!trackInfo || !trackInfo.track || !trackInfo.track.z0 || trackInfo.track.z0.length === 0) {
        console.log(`⏳ No existing tracking data for ${shipment.trackingNumber}, registering...`);
        
        // Register the tracking number
        const registerResponse = await makeSeventeenTrackRequest('/register', [{
          number: shipment.trackingNumber
        }], apiKey);
        
        console.log(`📝 Register response:`, JSON.stringify(registerResponse, null, 2));
        console.log(`⌛ Registered ${shipment.trackingNumber}, waiting for data...`);
        
        // Wait and retry to get tracking info (with polling)
        let attempts = 0;
        const maxAttempts = 3;
        const waitTime = 3000; // 3 seconds between attempts
        
        while (attempts < maxAttempts) {
          console.log(`🔄 Attempt ${attempts + 1}/${maxAttempts} to get tracking data for ${shipment.trackingNumber}`);
          
          // Wait before retry
          if (attempts > 0) {
            console.log(`⏱️ Waiting ${waitTime}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
          
          trackingData = await makeSeventeenTrackRequest('/gettrackinfo', [{
            number: shipment.trackingNumber
          }], apiKey);
          
          console.log(`📥 Attempt ${attempts + 1} response:`, JSON.stringify(trackingData, null, 2));
          
          trackInfo = trackingData.data && trackingData.data.accepted && trackingData.data.accepted[0];
          
          // Check if we now have tracking events
          if (trackInfo && trackInfo.track && trackInfo.track.z0 && trackInfo.track.z0.length > 0) {
            console.log(`✅ Got tracking data for ${shipment.trackingNumber} on attempt ${attempts + 1}`);
            break;
          } else {
            console.log(`❌ No tracking data yet for ${shipment.trackingNumber} on attempt ${attempts + 1}`);
          }
          
          attempts++;
        }
      } else {
        console.log(`✅ Found existing tracking data for ${shipment.trackingNumber}`);
      }
      
      // Process the tracking data
      let actuallyShipped = false;
      let isDelivered = false;
      let latestActivity = null;
      
      console.log(`\n🔍 Analyzing tracking data for ${shipment.trackingNumber}:`);
      
      if (trackInfo && trackInfo.track) {
        console.log(`📊 Track info found. Status code: ${trackInfo.track.e}`);
        console.log(`📊 Events count: ${trackInfo.track.z0 ? trackInfo.track.z0.length : 0}`);
        
        // Check track status - if there are any tracking events, it's been received by carrier
        const hasTrackingEvents = trackInfo.track.z0 && trackInfo.track.z0.length > 0;
        
        if (hasTrackingEvents) {
          console.log(`📋 Tracking events found:`);
          trackInfo.track.z0.forEach((event, index) => {
            console.log(`  Event ${index + 1}: ${event.z} | ${event.c} | ${event.a}`);
          });
        }
        
        // Check if status indicates it's been picked up
        const statusCode = trackInfo.track.e;
        console.log(`📈 Status code analysis: ${statusCode}`);
        
        // More lenient check - if there are any tracking events beyond just label creation
        if (hasTrackingEvents) {
          // Look for events that indicate actual movement
          const trackingEvents = trackInfo.track.z0;
          const hasMovementEvents = trackingEvents.some(event => {
            const eventText = (event.z || '').toLowerCase();
            const isMovement = eventText.includes('picked up') || 
                   eventText.includes('in transit') || 
                   eventText.includes('out for delivery') ||
                   eventText.includes('delivered') ||
                   eventText.includes('departed') ||
                   eventText.includes('arrived') ||
                   statusCode >= 10;
            
            console.log(`  🔍 Event analysis: "${eventText}" → movement: ${isMovement}`);
            return isMovement;
          });
          
          actuallyShipped = hasMovementEvents || statusCode >= 10;
          console.log(`📦 Actually shipped determination: ${actuallyShipped} (hasMovement: ${hasMovementEvents}, status: ${statusCode})`);
        } else {
          console.log(`📦 No tracking events found - not shipped`);
        }
        
        // Check if delivered
        isDelivered = statusCode === 40;
        console.log(`🏠 Delivered status: ${isDelivered}`);
        
        // Get latest tracking activity
        if (hasTrackingEvents && trackInfo.track.z0.length > 0) {
          const latestEvent = trackInfo.track.z0[0]; // Most recent event is first
          latestActivity = {
            status: latestEvent.z || '',
            location: latestEvent.c || '',
            time: latestEvent.a || '',
            description: latestEvent.z || ''
          };
          console.log(`📍 Latest activity:`, latestActivity);
        }
        
      } else {
        console.log(`❌ No tracking info found for ${shipment.trackingNumber} after all attempts`);
      }
      
      console.log(`\n✅ Final verification result for ${shipment.trackingNumber}:`);
      console.log(`   - Actually shipped: ${actuallyShipped}`);
      console.log(`   - Is delivered: ${isDelivered}`);
      console.log(`   - Has activity: ${!!latestActivity}`);
      
      verifiedShipments.push({
        ...shipment,
        actuallyShipped: actuallyShipped,
        isDelivered: isDelivered || checkShipmentDeliveryStatus(shipment),
        seventeenTrackStatus: trackInfo ? 'verified' : 'not_found',
        latestActivity: latestActivity
      });
      
    } catch (error) {
      console.error(`❌ Failed to verify tracking ${shipment.trackingNumber} with 17track:`, error.message);
      console.error(`Full error:`, error);
      
      // If 17track fails, fall back to ShipStation data
      verifiedShipments.push({
        ...shipment,
        actuallyShipped: true, // Assume shipped if we can't verify
        isDelivered: checkShipmentDeliveryStatus(shipment),
        seventeenTrackStatus: 'error',
        latestActivity: null
      });
    }
  }
  
  console.log(`\n=== 17TRACK VERIFICATION COMPLETE ===`);
  return verifiedShipments;
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
    
    console.log(`\n🌐 Making 17track API request:`);
    console.log(`URL: https://${options.hostname}${options.path}`);
    console.log(`Headers:`, {
      'Content-Type': options.headers['Content-Type'],
      'Content-Length': options.headers['Content-Length'],
      '17token': apiKey.substring(0, 3) + '***' + apiKey.substring(apiKey.length - 3)
    });
    console.log(`Body:`, postData);
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        console.log(`📥 17track API response status: ${res.statusCode}`);
        console.log(`📥 17track API response headers:`, res.headers);
        
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(data);
            console.log(`📥 17track API response body:`, JSON.stringify(parsedData, null, 2));
            resolve(parsedData);
          } catch (parseError) {
            console.error('❌ Failed to parse 17track response:', data);
            reject(new Error('Invalid response from 17track'));
          }
        } else {
          console.error(`❌ 17track API error ${res.statusCode}:`, data);
          reject(new Error(`17track API error: ${res.statusCode} - ${data}`));
        }
      });
    });
    
    req.on('error', (error) => {
      console.error('❌ 17track request error:', error);
      reject(error);
    });
    
    req.setTimeout(15000, () => {
      req.destroy();
      console.error('⏰ 17track request timeout');
      reject(new Error('17track request timeout'));
    });
    
    req.write(postData);
    req.end();
  });
}

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

    console.log(`🌐 Making request to: https://ssapi.shipstation.com${endpoint}`);

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        console.log(`📥 ShipStation API Response Status: ${res.statusCode}`);
        
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(data);
            resolve(parsedData);
          } catch (parseError) {
            console.error('❌ JSON parse error:', parseError);
            reject(new Error('Invalid response from ShipStation'));
          }
        } else if (res.statusCode === 401) {
          console.error('❌ Authentication failed - check API credentials');
          reject(new Error('Invalid ShipStation API credentials'));
        } else if (res.statusCode === 403) {
          console.error('❌ Access forbidden - check API permissions');
          reject(new Error('Access denied by ShipStation API'));
        } else if (res.statusCode === 404) {
          console.log('ℹ️ No data found for request');
          resolve({ orders: [], shipments: [] }); // No data found
        } else if (res.statusCode === 429) {
          console.error('❌ Rate limit exceeded');
          reject(new Error('Too many requests - please try again later'));
        } else {
          console.error(`❌ API Error ${res.statusCode}:`, data);
          reject(new Error(`ShipStation API error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Request error:', error);
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