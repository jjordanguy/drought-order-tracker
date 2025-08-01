exports.handler = async (event, context) => {
  console.log('Function called with method:', event.httpMethod);
  console.log('Headers:', event.headers);
  
  // Simple CORS headers that always work
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    console.log('Handling OPTIONS preflight request');
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: 'OK'
    };
  }

  // Handle POST
  if (event.httpMethod === 'POST') {
    console.log('Handling POST request');
    console.log('Body:', event.body);
    
    try {
      const { orderNumber, email } = JSON.parse(event.body);
      
      // For now, return a test response to confirm function works
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          message: 'Function is working!',
          received: { orderNumber, email }
        })
      };
      
    } catch (error) {
      console.error('Error:', error);
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: 'Invalid request' })
      };
    }
  }

  // Other methods
  return {
    statusCode: 405,
    headers: corsHeaders,
    body: JSON.stringify({ error: 'Method not allowed' })
  };
};