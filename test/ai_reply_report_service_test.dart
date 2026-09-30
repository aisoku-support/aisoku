import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:news_app/models/ai_reply_report.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:news_app/services/ai_reply_report_service.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });
  test(
    're-report sends the same target and original body only to report RPC',
    () async {
      final requests = <http.Request>[];
      final client = SupabaseClient(
        'https://example.com',
        'test-key',
        httpClient: MockClient((request) async {
          requests.add(request);
          return http.Response('', 204, request: request);
        }),
      );
      addTearDown(client.dispose);
      const reply = ReplyItem(
        text: 'original',
        type: ReplyType.ai,
        name: 'AI',
        id: 'resident',
        reportTargetId: 'local:test',
      );
      await AiReplyReportService.save(
        AiReplyReport(
          reply: reply,
          newsUrl: 'url',
          type: AiReplyReportType.other,
          note: 'note',
        ),
        client: client,
      );
      await AiReplyReportService.save(
        AiReplyReport(
          reply: reply,
          newsUrl: 'url',
          type: AiReplyReportType.harmfulOrAbusive,
          note: 'old note',
        ),
        client: client,
      );
      expect(requests, hasLength(2));
      for (final request in requests) {
        expect(request.method, 'POST');
        expect(request.url.path, '/rest/v1/rpc/save_ai_reply_report');
        final data = jsonDecode(request.body) as Map<String, dynamic>;
        expect(data.keys.toSet(), {
          'p_report_target_id',
          'p_news_url',
          'p_reply_text',
          'p_report_type',
          'p_note',
          'p_reporter_id',
        });
        expect(data['p_report_target_id'], 'local:test');
        expect(data['p_reply_text'], 'original');
        expect(data['p_reporter_id'], isA<String>());
        expect((data['p_reporter_id'] as String).length, 64);
      }
      final last = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(last['p_report_type'], 'harmful_or_abusive');
      expect(last['p_note'], isNull);
      expect(last['p_reporter_id'], firstReporter(requests));
    },
  );

  test('RPC failure propagates without retry', () async {
    var calls = 0;
    final client = SupabaseClient(
      'https://example.com',
      'test-key',
      httpClient: MockClient((request) async {
        calls++;
        return http.Response(
          '{"message":"unavailable","code":"test"}',
          400,
          request: request,
          headers: {'content-type': 'application/json'},
        );
      }),
    );
    addTearDown(client.dispose);
    const reply = ReplyItem(
      text: 'original',
      type: ReplyType.ai,
      name: 'AI',
      id: 'resident',
      reportTargetId: 'local:test',
    );
    await expectLater(
      AiReplyReportService.save(
        AiReplyReport(
          reply: reply,
          newsUrl: 'url',
          type: AiReplyReportType.other,
        ),
        client: client,
      ),
      throwsA(isA<PostgrestException>()),
    );
    expect(calls, 1);
  });
}

String firstReporter(List<http.Request> requests) =>
    (jsonDecode(requests.first.body) as Map<String, dynamic>)['p_reporter_id']
        as String;
