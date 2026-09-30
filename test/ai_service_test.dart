import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:news_app/ai_service.dart';
import 'package:news_app/models/conversation_pattern.dart';
import 'package:news_app/models/reply_item.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late http.Request lastRequest;
  var sharedInitialResponseStatus = 202;
  var sharedInitialResponseBody = <String, dynamic>{'status': 'running'};

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    sharedInitialResponseStatus = 202;
    sharedInitialResponseBody = {'status': 'running'};

    final mockClient = MockClient((request) async {
      lastRequest = request;
      if (request.url.path.endsWith('/functions/v1/generate-ai-replies') &&
          request.body.contains('sharedInitial')) {
        return http.Response(
          jsonEncode(sharedInitialResponseBody),
          sharedInitialResponseStatus,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode({'replies': List.generate(10, (i) => 'レス${i + 1}')}),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    final initFuture = Supabase.initialize(
      url: 'https://example.supabase.co',
      publishableKey: 'test-publishable-key',
      httpClient: mockClient,
      authOptions: const FlutterAuthClientOptions(
        localStorage: EmptyLocalStorage(),
      ),
    );
    AiService.setInitFuture(initFuture);
    await initFuture;
  });

  group('AiService.requestSharedInitial contract', () {
    test('sends only the Topic ID and parses a running receipt', () async {
      final result = await AiService.requestSharedInitial(
        topicId: '00000000-0000-0000-0000-000000000001',
      );

      expect(result.status, SharedInitialStatus.running);
      expect(jsonDecode(lastRequest.body), {
        'mode': 'sharedInitial',
        'topicId': '00000000-0000-0000-0000-000000000001',
      });
    });

    test('parses ready, deferred, and exhausted statuses', () async {
      for (final entry in [
        (200, 'ready', SharedInitialStatus.ready),
        (202, 'deferred', SharedInitialStatus.deferred),
        (200, 'exhausted', SharedInitialStatus.exhausted),
      ]) {
        sharedInitialResponseStatus = entry.$1;
        sharedInitialResponseBody = {'status': entry.$2};
        expect(
          (await AiService.requestSharedInitial(topicId: 'topic-id')).status,
          entry.$3,
        );
      }
    });

    test('does not treat a failed HTTP response as ready', () async {
      sharedInitialResponseStatus = 503;
      await expectLater(
        AiService.requestSharedInitial(topicId: 'topic-id'),
        throwsA(isA<AiServiceException>()),
      );
    });
  });

  group('AiService.generateReplies payload tests', () {
    test('sends server-owned shared chunk persistence contract', () async {
      await AiService.generateReplies(
        newsTitle: 'ニュースタイトル',
        articleBody: 'ニュース本文',
        replyRelations: [const ReplyRelation(from: 2, to: 1)],
        articleUrl: 'https://example.com/article',
        chunkIndex: 2,
        conversationPattern: 'singleReply',
      );

      final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;
      expect(payload['articleUrl'], 'https://example.com/article');
      expect(payload['chunkIndex'], 2);
      expect(payload['conversationPattern'], 'singleReply');
    });

    test('topicThreadTitle is null when original is null', () async {
      await AiService.generateReplies(
        newsTitle: 'ニュースタイトル',
        articleBody: 'ニュース本文',
        topicSubject: 'トピックテーマ',
        topicEvent: 'トピックイベント',
        topicFacts: ['事実1'],
        topicThreadTitle: null,
        useTopicContext: true,
        replyRelations: [const ReplyRelation(from: 2, to: 1)],
        count: 10,
        context: [],
      );

      final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;
      expect(payload.containsKey('topicThreadTitle'), isTrue);
      expect(payload['topicThreadTitle'], isNull);
    });

    test('topicThreadTitle is null when original is empty string', () async {
      await AiService.generateReplies(
        newsTitle: 'ニュースタイトル',
        articleBody: 'ニュース本文',
        topicSubject: 'トピックテーマ',
        topicEvent: 'トピックイベント',
        topicFacts: ['事実1'],
        topicThreadTitle: '',
        useTopicContext: true,
        replyRelations: [const ReplyRelation(from: 2, to: 1)],
        count: 10,
        context: [],
      );

      final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;
      expect(payload['topicThreadTitle'], isNull);
    });

    test('topicThreadTitle is null when original is blank spaces', () async {
      await AiService.generateReplies(
        newsTitle: 'ニュースタイトル',
        articleBody: 'ニュース本文',
        topicSubject: 'トピックテーマ',
        topicEvent: 'トピックイベント',
        topicFacts: ['事実1'],
        topicThreadTitle: '   ',
        useTopicContext: true,
        replyRelations: [const ReplyRelation(from: 2, to: 1)],
        count: 10,
        context: [],
      );

      final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;
      expect(payload['topicThreadTitle'], isNull);
    });

    test(
      'topicThreadTitle is preserved when valid title is provided',
      () async {
        await AiService.generateReplies(
          newsTitle: 'ニュースタイトル',
          articleBody: 'ニュース本文',
          topicSubject: 'トピックテーマ',
          topicEvent: 'トピックイベント',
          topicFacts: ['事実1'],
          topicThreadTitle: '正常なタイトル',
          useTopicContext: true,
          replyRelations: [const ReplyRelation(from: 2, to: 1)],
          count: 10,
          context: [],
        );

        final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;
        expect(payload['topicThreadTitle'], '正常なタイトル');
      },
    );

    test(
      'verifies all required sharedAi payload fields and regression check',
      () async {
        final contextReplies = [
          const ReplyItem(
            text: '過去レス1',
            type: ReplyType.ai,
            name: 'AI',
            id: '1',
            origin: ReplyOrigin.sharedAi,
          ),
        ];

        await AiService.generateReplies(
          newsTitle: 'ニュースタイトル',
          articleBody: 'ニュース本文',
          topicSubject: 'トピックテーマ',
          topicEvent: 'トピックイベント',
          topicFacts: ['事実1', '事実2'],
          topicThreadTitle: 'トピックタイトル',
          useTopicContext: true,
          replyRelations: [const ReplyRelation(from: 2, to: 1)],
          count: 10,
          context: contextReplies,
        );

        final payload = jsonDecode(lastRequest.body) as Map<String, dynamic>;

        expect(payload['mode'], 'sharedAi');
        expect(payload['count'], 10);
        expect(payload['newsTitle'], 'ニュースタイトル');
        expect(payload['articleBody'], 'ニュース本文');
        expect(payload['topicSubject'], 'トピックテーマ');
        expect(payload['topicEvent'], 'トピックイベント');
        expect(payload['topicFacts'], ['事実1', '事実2']);
        expect(payload['topicThreadTitle'], 'トピックタイトル');
        expect(payload['useTopicContext'], isTrue);
        expect(payload['replyRelations'], [
          {'from': 2, 'to': 1},
        ]);
        expect(payload['context'], ['過去レス1']);
      },
    );
  });
}
