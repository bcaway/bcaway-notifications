export interface Env {
  DB: D1Database;
  ADMIN_API_KEY?: string;
  SYNC_SECRET?: string;
}

interface RegisterPayload {
  token: string;
  platform?: string;
  starredTeachers?: string[];
}

interface SendPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface AbsenceEvent {
  type: 'inserted' | 'updated' | 'removed';
  teacher: string;
  periodsImpacted?: string;
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

export function formatAbsenceData(periodsImpacted?: string): string {
  if (!periodsImpacted || periodsImpacted.trim() === '') return 'All Day';
  const trimmed = periodsImpacted.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'all' || lower === 'all day') return 'All Day';

  // Check if it represents all periods (1-9 and optional igs)
  const tokens = lower
    .replace(/^periods?:?\s*/i, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const numTokens = new Set(tokens.filter(t => /^[1-9]$/.test(t)));
  if (numTokens.size >= 9 || tokens.length >= 10) {
    return 'All Day';
  }

  if (lower.startsWith('period') || lower.startsWith('mod')) return trimmed;
  return `Periods: ${trimmed}`;
}

export function buildAbsenceNotification(event: {
  type: 'inserted' | 'updated' | 'removed';
  teacher: string;
  periodsImpacted?: string;
}): { title: string; body: string } {
  const teacher = event.teacher.trim();
  const title = `Teacher Absence: ${teacher}`;
  const absenceData = formatAbsenceData(event.periodsImpacted);

  let body = '';
  switch (event.type) {
    case 'inserted':
      body = `${teacher} is absent today: ${absenceData}.`;
      break;
    case 'updated':
      body = `${teacher}'s absences updated: ${absenceData}`;
      break;
    case 'removed':
      body = `${teacher} is no longer absent today`;
      break;
  }

  return { title, body };
}

interface SendPushOptions {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

async function sendExpoPush(
  options: SendPushOptions,
  env: Env
): Promise<{ total: number; sent: number; failed: number; purged: number }> {
  const { tokens, title, body, data } = options;
  if (!tokens || tokens.length === 0) {
    return { total: 0, sent: 0, failed: 0, purged: 0 };
  }

  const BATCH_SIZE = 100;
  let successfulTickets = 0;
  let errorTickets = 0;
  const tokensToPurge: string[] = [];

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const tokenBatch = tokens.slice(i, i + BATCH_SIZE);
    const messages = tokenBatch.map(tok => ({
      to: tok,
      sound: 'default',
      title: title.trim(),
      body: body.trim(),
      data: data || {},
    }));

    try {
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
    } catch (err) {
      console.error('[Send] Network error contacting Expo:', err);
      errorTickets += tokenBatch.length;
    }
  }

  // Purge dead tokens
  let purgedCount = 0;
  if (tokensToPurge.length > 0) {
    console.log(`[Send] Purging ${tokensToPurge.length} unregistered device tokens from D1...`);
    for (const deadToken of tokensToPurge) {
      try {
        await env.DB.prepare('DELETE FROM push_tokens WHERE token = ?1').bind(deadToken).run();
        await env.DB.prepare('DELETE FROM token_starred_teachers WHERE token = ?1').bind(deadToken).run();
        purgedCount++;
      } catch (err) {
        console.error('[Send] Failed to purge token:', deadToken, err);
      }
    }
  }

  return {
    total: tokens.length,
    sent: successfulTickets,
    failed: errorTickets,
    purged: purgedCount,
  };
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
        const starredSubResult = await env.DB.prepare('SELECT COUNT(DISTINCT token) as count FROM token_starred_teachers').first<{ count: number }>();
        return jsonResponse({
          valid: true,
          totalRegisteredTokens: countResult?.count ?? 0,
          tokensWithStarredTeachers: starredSubResult?.count ?? 0,
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
        const { token, platform, starredTeachers } = body;

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

        // If starredTeachers provided, update token_starred_teachers
        if (Array.isArray(starredTeachers)) {
          await env.DB.prepare('DELETE FROM token_starred_teachers WHERE token = ?1')
            .bind(token)
            .run();

          for (const tName of starredTeachers) {
            const clean = String(tName || '').trim();
            if (clean) {
              await env.DB.prepare(
                'INSERT OR IGNORE INTO token_starred_teachers (token, teacher_name) VALUES (?1, ?2)'
              )
                .bind(token, clean)
                .run();
            }
          }
        }

        return jsonResponse({
          success: true,
          message: 'Push token registered successfully',
          starredCount: Array.isArray(starredTeachers) ? starredTeachers.length : undefined,
        });
      } catch (error) {
        console.error('[Register] Error saving token:', error);
        return jsonResponse({ error: 'Failed to register token' }, 500);
      }
    }

    // POST /sync-starred - Sync starred teachers for a device token
    if (request.method === 'POST' && url.pathname === '/sync-starred') {
      try {
        const body = (await request.json()) as { token: string; starredTeachers: string[] };
        const { token, starredTeachers } = body;

        if (!token || !isValidExpoPushToken(token)) {
          return jsonResponse({ error: 'Invalid Expo push token' }, 400);
        }

        if (!Array.isArray(starredTeachers)) {
          return jsonResponse({ error: 'starredTeachers must be an array' }, 400);
        }

        // Ensure token exists in push_tokens
        await env.DB.prepare(
          `INSERT INTO push_tokens (token, platform, updated_at)
           VALUES (?1, 'unknown', CURRENT_TIMESTAMP)
           ON CONFLICT(token) DO UPDATE SET updated_at = CURRENT_TIMESTAMP`
        )
          .bind(token)
          .run();

        // Clear existing mappings for this token
        await env.DB.prepare('DELETE FROM token_starred_teachers WHERE token = ?1')
          .bind(token)
          .run();

        // Insert new mappings
        let count = 0;
        for (const tName of starredTeachers) {
          const clean = String(tName || '').trim();
          if (clean) {
            await env.DB.prepare(
              'INSERT OR IGNORE INTO token_starred_teachers (token, teacher_name) VALUES (?1, ?2)'
            )
              .bind(token, clean)
              .run();
            count++;
          }
        }

        return jsonResponse({
          success: true,
          token,
          syncedCount: count,
        });
      } catch (error) {
        console.error('[SyncStarred] Error:', error);
        return jsonResponse({ error: 'Failed to sync starred teachers' }, 500);
      }
    }

    // POST /notify-absence - Process absence changes and notify subscribers even when app is closed
    if (request.method === 'POST' && url.pathname === '/notify-absence') {
      try {
        const body = await request.json() as any;
        const rawEvents = Array.isArray(body.events)
          ? body.events
          : (body.type && body.teacher)
          ? [body]
          : [];

        if (rawEvents.length === 0) {
          return jsonResponse({ success: true, message: 'No events provided', processed: 0 });
        }

        const results = [];

        for (const raw of rawEvents) {
          const type = String(raw.type || '').toLowerCase();
          const teacher = String(raw.teacher || '').trim();
          const periodsImpacted = raw.periodsImpacted ? String(raw.periodsImpacted).trim() : undefined;

          if (!['inserted', 'updated', 'removed'].includes(type) || !teacher) {
            continue;
          }

          const { title, body: msgBody } = buildAbsenceNotification({
            type: type as 'inserted' | 'updated' | 'removed',
            teacher,
            periodsImpacted,
          });

          // Query all tokens subscribed to this teacher
          const { results: tokenRows } = await env.DB.prepare(
            `SELECT DISTINCT token FROM token_starred_teachers 
             WHERE teacher_name = ?1 COLLATE NOCASE`
          )
            .bind(teacher)
            .all<{ token: string }>();

          const tokens = (tokenRows || []).map(r => r.token);

          if (tokens.length === 0) {
            results.push({
              teacher,
              type,
              tokensNotified: 0,
              reason: 'No subscribers for this teacher',
            });
            continue;
          }

          const sendResult = await sendExpoPush(
            {
              tokens,
              title,
              body: msgBody,
              data: {
                type: 'teacher_absence',
                changeType: type,
                teacher,
                periodsImpacted,
              },
            },
            env
          );

          results.push({
            teacher,
            type,
            tokensTargeted: tokens.length,
            sent: sendResult.sent,
            failed: sendResult.failed,
          });
        }

        return jsonResponse({
          success: true,
          processed: results.length,
          results,
        });
      } catch (err) {
        console.error('[NotifyAbsence] Error:', err);
        return jsonResponse({ error: 'Failed to process absence notification.' }, 500);
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
        const sendResult = await sendExpoPush(
          {
            tokens,
            title: title.trim(),
            body: messageBody.trim(),
            data,
          },
          env
        );

        return jsonResponse({
          success: true,
          message: `Broadcast complete to ${tokens.length} device(s).`,
          totalTokens: tokens.length,
          sent: sendResult.sent,
          failed: sendResult.failed,
          purged: sendResult.purged,
        });
      } catch (error) {
        console.error('[Send] Error processing broadcast:', error);
        return jsonResponse({ error: 'Failed to process notification broadcast.' }, 500);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
};
