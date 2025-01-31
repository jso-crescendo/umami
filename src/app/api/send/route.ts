import { z } from 'zod';
import { isbot } from 'isbot';
import { serializeError } from 'serialize-error';
import { createToken, parseToken, safeDecodeURI } from 'next-basics';
import clickhouse from 'lib/clickhouse';
import { parseRequest } from 'lib/request';
import { badRequest, json, forbidden, serverError } from 'lib/response';
import { fetchSession, fetchWebsite } from 'lib/load';
import { getClientInfo, hasBlockedIp } from 'lib/detect';
import { secret, uuid, visitSalt } from 'lib/crypto';
import { createSession, saveEvent, saveSessionData } from 'queries';
import { COLLECTION_TYPE } from 'lib/constants';

export async function POST(request: Request) {
  // Bot check
  if (!process.env.DISABLE_BOT_CHECK && isbot(request.headers.get('user-agent'))) {
    return json({ beep: 'boop' });
  }

  const schema = z.object({
    type: z.enum(['event', 'identity']),
    payload: z.object({
      website: z.string().uuid(),
      data: z.object({}).passthrough().optional(),
      hostname: z.string().max(100).optional(),
      language: z.string().max(35).optional(),
      referrer: z.string().optional(),
      screen: z.string().max(11).optional(),
      title: z.string().optional(),
      url: z.string().optional(),
      name: z.string().max(50).optional(),
      tag: z.string().max(50).optional(),
      ip: z.string().ip().optional(),
      userAgent: z.string().optional(),
    }),
  });

  const { body, error } = await parseRequest(request, schema, { skipAuth: true });

  if (error) {
    return error();
  }

  const { type, payload } = body;

  const {
    website: websiteId,
    hostname,
    screen,
    language,
    url,
    referrer,
    name,
    data,
    title,
    tag,
  } = payload;

  // Cache check
  let cache: { websiteId: string; sessionId: string; visitId: string; iat: number } | null = null;
  const cacheHeader = request.headers.get('x-umami-cache');

  if (cacheHeader) {
    const result = await parseToken(cacheHeader, secret());

    if (result) {
      cache = result;
    }
  }

  // Find website
  if (!cache?.websiteId) {
    const website = await fetchWebsite(websiteId);

    if (!website) {
      return badRequest('Website not found.');
    }
  }

  // Client info
  const { ip, userAgent, device, browser, os, country, subdivision1, subdivision2, city } =
    await getClientInfo(request, payload);

  // IP block
  if (hasBlockedIp(ip)) {
    return forbidden();
  }

  const sessionId = uuid(websiteId, hostname, ip, userAgent);

  // Find session
  if (!cache?.sessionId) {
    const session = await fetchSession(websiteId, sessionId);

    // Create a session if not found
    if (!session && !clickhouse.enabled) {
      try {
        await createSession({
          id: sessionId,
          websiteId,
          hostname,
          browser,
          os,
          device,
          screen,
          language,
          country,
          subdivision1,
          subdivision2,
          city,
        });
      } catch (e: any) {
        if (!e.message.toLowerCase().includes('unique constraint')) {
          return serverError(serializeError(e));
        }
      }
    }
  }

  // Visit info
  const now = Math.floor(new Date().getTime() / 1000);
  let visitId = cache?.visitId || uuid(sessionId, visitSalt());
  let iat = cache?.iat || now;

  // Expire visit after 30 minutes
  if (now - iat > 1800) {
    visitId = uuid(sessionId, visitSalt());
    iat = now;
  }

  if (type === COLLECTION_TYPE.event) {
    // eslint-disable-next-line prefer-const
    let [urlPath, urlQuery] = safeDecodeURI(url)?.split('?') || [];
    let [referrerPath, referrerQuery] = safeDecodeURI(referrer)?.split('?') || [];
    let referrerDomain = '';

    if (!urlPath) {
      urlPath = '/';
    }

    if (/^[\w-]+:\/\/\w+/.test(referrerPath)) {
      const refUrl = new URL(referrer);
      referrerPath = refUrl.pathname;
      referrerQuery = refUrl.search.substring(1);
      referrerDomain = refUrl.hostname.replace(/www\./, '');
    }

    if (process.env.REMOVE_TRAILING_SLASH) {
      urlPath = urlPath.replace(/(.+)\/$/, '$1');
    }

    await saveEvent({
      websiteId,
      sessionId,
      visitId,
      urlPath,
      urlQuery,
      referrerPath,
      referrerQuery,
      referrerDomain,
      pageTitle: title,
      eventName: name,
      eventData: data,
      hostname,
      browser,
      os,
      device,
      screen,
      language,
      country,
      subdivision1,
      subdivision2,
      city,
      tag,
    });
  }

  if (type === COLLECTION_TYPE.identify) {
    if (!data) {
      return badRequest('Data required.');
    }

    await saveSessionData({
      websiteId,
      sessionId,
      sessionData: data,
    });
  }

  const token = createToken({ websiteId, sessionId, visitId, iat }, secret());

  return json({ cache: token });
}
