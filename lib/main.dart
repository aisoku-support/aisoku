import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'pages/news_home_page.dart';
import 'services/startup_perf.dart';
import 'services/news_cache_service.dart';
import 'services/theme_service.dart';
import 'ai_service.dart';

Future<void> main() async {
  StartupPerf.start();

  WidgetsFlutterBinding.ensureInitialized();
  unawaited(ThemeService.instance.init());

  // Supabase初期化（dotenv込）を非同期で開始し、runAppを一切ブロックしないようにする
  final supabaseInitFuture = () async {
    await dotenv.load(fileName: '.env');

    final supabaseUrl = dotenv.env['SUPABASE_URL'] ?? '';
    final supabasePublishableKey = dotenv.env['SUPABASE_PUBLISHABLE_KEY'] ?? '';

    if (supabaseUrl.isEmpty || supabasePublishableKey.isEmpty) {
      throw Exception('Supabaseの接続情報が設定されていません');
    }

    return await Supabase.initialize(
      url: supabaseUrl,
      publishableKey: supabasePublishableKey,
    );
  }();

  NewsCacheService.setInitFuture(supabaseInitFuture);
  AiService.setInitFuture(supabaseInitFuture);

  runApp(const NewsApp());
}

class NewsApp extends StatelessWidget {
  const NewsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: ThemeService.instance,
      builder: (context, _) {
        return MaterialApp(
          debugShowCheckedModeBanner: false,
          title: 'AIニュース掲示板',
          themeMode: ThemeService.instance.themeMode,
          theme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor: Colors.blue,
              brightness: Brightness.light,
            ),
            scaffoldBackgroundColor: const Color(0xfff5f6fa),
            useMaterial3: true,
          ),
          darkTheme: ThemeData(
            colorScheme: ColorScheme.fromSeed(
              seedColor: Colors.blue,
              brightness: Brightness.dark,
              surface: const Color(0xFF1E1E1E),
            ),
            scaffoldBackgroundColor: const Color(0xFF121212),
            cardColor: const Color(0xFF1E1E1E),
            useMaterial3: true,
          ),
          locale: const Locale('ja', 'JP'),
          localizationsDelegates: const [
            GlobalMaterialLocalizations.delegate,
            GlobalWidgetsLocalizations.delegate,
            GlobalCupertinoLocalizations.delegate,
          ],
          supportedLocales: const [Locale('ja', 'JP')],
          home: const NewsHomePage(),
        );
      },
    );
  }
}
