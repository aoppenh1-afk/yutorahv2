import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { XMLParser } from 'fast-xml-parser';
import { followsToImport, mergeTeacherFollows } from '../lib/account-follows';
import {
  catalogItems,
  rssItems,
  validPushEndpoint,
  deliveryFailure,
} from '../supabase/functions/notify-shiurim/core';
import type { Follow } from '../lib/learning';
import { restoreLearning } from '../lib/learning';

const teacher: Follow = { kind: 'teacher', id: 81959, name: 'Teacher' };
const topic: Follow = { kind: 'topic', id: 10, name: 'Topic' };
const remote = {
  teacher_id: 81959,
  teacher_name: 'Teacher',
  image: null,
  following: true,
};
void test('cloud teacher follows do not discard this device’s topic and series follows', () => {
  const teachers = Array.from({ length: 100 }, (_, i) => ({
    teacher_id: i + 1,
    teacher_name: 'Teacher',
    image: null,
    following: true,
  }));
  const topics: Follow[] = Array.from({ length: 100 }, (_, i) => ({
    kind: 'topic',
    id: i + 1,
    name: 'Topic',
  }));
  const restored = restoreLearning({
    following: mergeTeacherFollows(topics, teachers, {}),
  });
  assert.equal(
    restored.following.filter((f) => f.kind === 'teacher').length,
    100,
  );
  assert.equal(
    restored.following.filter((f) => f.kind === 'topic').length,
    100,
  );
});
void test('first sign-in imports local teachers and respects remote unfollows', () => {
  assert.deepEqual(followsToImport([teacher, topic], [], null, 'user-a'), [
    teacher,
  ]);
  assert.deepEqual(
    followsToImport(
      [teacher],
      [{ ...remote, following: false }],
      null,
      'user-a',
    ),
    [],
  );
});
void test('switching accounts never imports another account’s teachers', () => {
  assert.deepEqual(followsToImport([teacher], [], 'user-a', 'user-b'), []);
  assert.deepEqual(mergeTeacherFollows([teacher, topic], [], {}), [topic]);
});
void test('pending follow/unfollow edits win over a stale cloud response', () => {
  assert.deepEqual(
    mergeTeacherFollows([teacher, topic], [remote], {
      '81959': { follow: teacher, following: false, operation: 'new' },
    }),
    [topic],
  );
  assert.deepEqual(
    mergeTeacherFollows([topic], [], {
      '81959': { follow: teacher, following: true, operation: 'new' },
    }),
    [teacher, topic],
  );
});
void test('catalog detection accepts videos and backdated recordings by ID', () => {
  assert.deepEqual(
    catalogItems({
      response: {
        numFound: 2,
        docs: [
          {
            shiurid: 1191258,
            shiurtitle: 'Video',
            shiurdate: '2020-01-01',
            mediatypecategory: 'video',
          },
          { shiurID: 1191323, shiurTitle: 'Audio' },
        ],
      },
    }),
    {
      total: 2,
      items: [
        { id: 1191258, title: 'Video' },
        { id: 1191323, title: 'Audio' },
      ],
    },
  );
  assert.throws(
    () => catalogItems({ response: { docs: [] } }),
    /invalid catalog/,
  );
  assert.throws(
    () =>
      catalogItems({
        response: {
          numFound: 1,
          docs: [{ shiurid: 0, shiurtitle: 'Invalid' }],
        },
      }),
    /invalid recording/,
  );
});
void test('RSS parsing uses lecture ID and never the unreliable publication date', () => {
  const parser = new XMLParser({ processEntities: false });
  const xml =
    '<rss><channel><item><title>New upload of an old recording</title><link>https://www.yutorah.org/lectures/lecture/1191323/test/</link><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate></item></channel></rss>';
  assert.deepEqual(rssItems(parser.parse(xml)), [
    { id: 1191323, title: 'New upload of an old recording' },
  ]);
  assert.throws(
    () => rssItems({ error: 'Unavailable' }),
    /invalid upload feed/,
  );
});
void test('push delivery cannot request arbitrary hosts, ports, or credentials', () => {
  for (const url of [
    'https://fcm.googleapis.com/fcm/send/token',
    'https://updates.push.services.mozilla.com/wpush/v2/token',
    'https://web.push.apple.com/token',
  ])
    assert.equal(validPushEndpoint(url), true);
  for (const url of [
    'http://fcm.googleapis.com/token',
    'https://fcm.googleapis.com.evil.test/token',
    'https://127.0.0.1/token',
    'https://fcm.googleapis.com:8443/token',
    'https://user:pass@fcm.googleapis.com/token',
  ])
    assert.equal(validPushEndpoint(url), false);
});
void test('expired endpoints are removed and transient delivery errors retry with a bound', () => {
  assert.equal(deliveryFailure(410, 1).remove, true);
  assert.equal(deliveryFailure(404, 1).remove, true);
  assert.equal(deliveryFailure(429, 1).abandon, false);
  assert.equal(deliveryFailure(503, 4).abandon, false);
  assert.equal(deliveryFailure(undefined, 5).abandon, true);
  assert.equal(deliveryFailure(403, 1).abandon, true);
});
void test('service worker always displays a notification and confines click targets to YUTorah', async () => {
  const events = new Map<string, (event: unknown) => void>();
  const notifications: unknown[] = [];
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      events.set(type, handler),
    skipWaiting: () => {},
    location: { origin: 'https://yutorah.vercel.app' },
    registration: {
      showNotification: (title: string, options: unknown) => {
        notifications.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve([]),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
  };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), { self, URL });
  let done = Promise.resolve();
  events.get('push')!({
    data: {
      json: () => ({
        title: 'A new shiur',
        body: 'Title',
        url: 'https://evil.test',
        tag: 'shiur-1191258',
      }),
    },
    waitUntil: (p: Promise<void>) => {
      done = p;
    },
  });
  await done;
  assert.equal(notifications.length, 1);
  const notification = notifications[0] as {
    options: { data: { url: string } };
  };
  assert.equal(notification.options.data.url, '/?shiur=1191258');
  events.get('notificationclick')!({
    notification: { data: { url: 'https://evil.test' }, close: () => {} },
    waitUntil: (p: Promise<void>) => {
      done = p;
    },
  });
  await done;
  assert.equal(opened[0], 'https://yutorah.vercel.app/?view=following');
  events.get('push')!({
    data: {
      json: () => {
        throw new Error('Malformed');
      },
    },
    waitUntil: (p: Promise<void>) => {
      done = p;
    },
  });
  await done;
  assert.equal(notifications.length, 2);
});
