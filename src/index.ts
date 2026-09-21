export interface Env {
  DB: D1Database;
  ADMIN_API_KEY?: string;
}

interface RegisterPayload {
  token: string;
  platform?: string;
}

interface SendPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: {
    error?: 'DeviceNotRegistered' | 'InvalidCredentials' | 'MessageTooBig' | 'MessageRateExceeded' | string;
  };
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authenticateAdmin(request: Request, env: Env): boolean {
  const configuredKey = env.ADMIN_API_KEY;
  if (!configuredKey || configuredKey.trim() === '') {
    console.error('[Auth] ADMIN_API_KEY is not configured on the Worker.');
    return false;
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const providedKey = authHeader.slice(7).trim();
  return timingSafeEqual(providedKey, configuredKey.trim());
}

function isValidExpoPushToken(token: string): boolean {
  return (
    typeof token === 'string' &&
    (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
    token.endsWith(']')
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        status: 'ok',
        service: 'bcaway-notifications',
        timestamp: new Date().toISOString(),
      });
    }

    // Admin verify / stats check
    if (url.pathname === '/admin/stats' || url.pathname === '/verify') {
      if (!authenticateAdmin(request, env)) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      try {
        const countResult = await env.DB.prepare('SELECT COUNT(*) as count FROM push_tokens').first<{ count: number }>();
        return jsonResponse({
          valid: true,
          totalRegisteredTokens: countResult?.count ?? 0,
        });
      } catch (err) {
        console.error('[Stats] Error querying token count:', err);
        return jsonResponse({ error: 'Database query failed' }, 500);
      }
    }

    // POST /register - End-user app token registration
    if (request.method === 'POST' && url.pathname === '/register') {
      try {
        const body = (await request.json()) as RegisterPayload;
        const { token, platform } = body;

        if (!token || !isValidExpoPushToken(token)) {
          return jsonResponse(
            { error: 'Invalid token format. Must be a valid Expo push token.' },
            400
          );
        }

        const validPlatform = (platform && typeof platform === 'string') ? platform.toLowerCase().slice(0, 20) : 'unknown';

        await env.DB.prepare(
          `INSERT INTO push_tokens (token, platform, updated_at)
           VALUES (?1, ?2, CURRENT_TIMESTAMP)
           ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, updated_at = CURRENT_TIMESTAMP`
        )
          .bind(token, validPlatform)
          .run();

        return jsonResponse({
          success: true,
          message: 'Push token registered successfully',
        });
      } catch (error) {
        console.error('[Register] Error saving token:', error);
        return jsonResponse({ error: 'Failed to register token' }, 500);
      }
    }

    // POST /send - Admin broadcast endpoint
    if (request.method === 'POST' && url.pathname === '/send') {
      if (!authenticateAdmin(request, env)) {
        return jsonResponse(
          { error: 'Unauthorized: Invalid or missing admin credentials.' },
          401
        );
      }

      try {
        const body = (await request.json()) as SendPayload;
        const { title, body: messageBody, data } = body;

        if (!title || typeof title !== 'string' || title.trim() === '') {
          return jsonResponse({ error: 'Title is required and must not be empty.' }, 400);
        }

        if (!messageBody || typeof messageBody !== 'string' || messageBody.trim() === '') {
          return jsonResponse({ error: 'Body is required and must not be empty.' }, 400);
        }

        // Fetch all tokens
        const { results } = await env.DB.prepare('SELECT token FROM push_tokens').all<{ token: string }>();

        if (!results || results.length === 0) {
          return jsonResponse({
            success: true,
            message: 'No registered push tokens found.',
            totalTokens: 0,
            sent: 0,
            failed: 0,
            purged: 0,
          });
        }

        const tokens = results.map(r => r.token);
        const BATCH_SIZE = 100;
        let successfulTickets = 0;
        let errorTickets = 0;
        const tokensToPurge: string[] = [];

        // Chunk into batches of 100 as required by Expo Push Service
        for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
          const tokenBatch = tokens.slice(i, i + BATCH_SIZE);
          const messages = tokenBatch.map(tok => ({
            to: tok,
            sound: 'default',
            title: title.trim(),
            body: messageBody.trim(),
            data: data || {},
          }));

          const expoResponse = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip, deflate',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(messages),
          });

          if (!expoResponse.ok) {
            const errorText = await expoResponse.text();
            console.error('[Send] Expo server returned error:', expoResponse.status, errorText);
            errorTickets += tokenBatch.length;
            continue;
          }

          const expoData = (await expoResponse.json()) as { data?: ExpoTicket[] };
          const tickets = expoData.data || [];

          for (let j = 0; j < tickets.length; j++) {
            const ticket = tickets[j];
            if (ticket.status === 'ok') {
              successfulTickets++;
            } else {
              errorTickets++;
              console.warn('[Send] Delivery error ticket:', ticket);
              if (ticket.details?.error === 'DeviceNotRegistered') {
                tokensToPurge.push(tokenBatch[j]);
              }
            }
          }
        }

        // Clean up any tokens that are no longer valid
        let purgedCount = 0;
        if (tokensToPurge.length > 0) {
          console.log(`[Send] Purging ${tokensToPurge.length} unregistered device tokens from D1...`);
          for (const deadToken of tokensToPurge) {
            try {
              await env.DB.prepare('DELETE FROM push_tokens WHERE token = ?1').bind(deadToken).run();
              purgedCount++;
            } catch (err) {
              console.error('[Send] Failed to purge token:', deadToken, err);
            }
          }
        }

        return jsonResponse({
          success: true,
          message: `Broadcast complete to ${tokens.length} device(s).`,
          totalTokens: tokens.length,
          sent: successfulTickets,
          failed: errorTickets,
          purged: purgedCount,
        });
      } catch (error) {
        console.error('[Send] Error processing broadcast:', error);
        return jsonResponse({ error: 'Failed to process notification broadcast.' }, 500);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
