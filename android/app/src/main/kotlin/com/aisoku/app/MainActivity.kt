package com.aisoku.app

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.googlemobileads.GoogleMobileAdsPlugin

class MainActivity : FlutterActivity() {
    companion object {
        private const val TAG = "MainActivity"
        
        // Custom Tabs Activity States
        private const val STATE_MAXIMIZED = 2
        private const val STATE_FULL_SCREEN = 5
        
        // Custom Tabs Navigation Events
        private const val TAB_HIDDEN = 6
    }

    private var customTabsClient: CustomTabsClient? = null
    private var customTabsSession: CustomTabsSession? = null
    private var customTabsChannel: MethodChannel? = null

    private val customTabsCallback = object : CustomTabsCallback() {
        override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
            // TAB_HIDDEN = 6
            if (navigationEvent == TAB_HIDDEN) {
                runOnUiThread {
                    customTabsChannel?.invokeMethod("onPartialTabLayerUpdate", mapOf(
                        "active" to false
                    ))
                }
            }
        }

        override fun onActivityLayout(left: Int, top: Int, right: Int, bottom: Int, state: Int, extras: Bundle) {
            runOnUiThread {
                customTabsChannel?.invokeMethod("onPartialTabLayerUpdate", mapOf(
                    "active" to true,
                    "top" to top,
                    "state" to state
                ))
            }
        }
    }

    private val connection = object : CustomTabsServiceConnection() {
        override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
            customTabsClient = client
            client.warmup(0L)
            customTabsSession = client.newSession(customTabsCallback)
        }

        override fun onServiceDisconnected(name: ComponentName) {
            customTabsClient = null
            customTabsSession = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            CustomTabsClient.bindCustomTabsService(this, "com.android.chrome", connection)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to bind CustomTabsService", e)
        }
    }

    override fun onDestroy() {
        try {
            unbindService(connection)
        } catch (e: Exception) {
            // Ignore if not bound
        }
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) {
            runOnUiThread {
                customTabsChannel?.invokeMethod("onForegroundRestored", null)
            }
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "news_app/native_ads")
        GoogleMobileAdsPlugin.registerNativeAdFactory(flutterEngine, "newsNativeFactory", NewsNativeAdFactory(this, channel))
        GoogleMobileAdsPlugin.registerNativeAdFactory(flutterEngine, "threadNativeFactory", ThreadNativeAdFactory(this, channel))

        // Custom Tabs Channel
        val channel2 = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "news_app/custom_tabs")
        customTabsChannel = channel2
        channel2.setMethodCallHandler { call, result ->
            when (call.method) {
                "launchPartialCustomTab" -> {
                    val url = call.argument<String>("url")
                    if (url != null) {
                        launchPartialCustomTab(url)
                        result.success(null)
                    } else {
                        result.error("INVALID_ARGUMENT", "URL is null", null)
                    }
                }
                "returnFromPartialTabForReply" -> {
                    returnFromPartialTabForReply()
                    result.success(null)
                }
                else -> {
                    result.notImplemented()
                }
            }
        }
    }

    private fun returnFromPartialTabForReply() {
        try {
            val intent = Intent(this, MainActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Error returning from partial tab", e)
        }
    }

    private fun launchPartialCustomTab(url: String) {
        try {
            val displayMetrics = resources.displayMetrics
            val totalHeight = displayMetrics.heightPixels
            val heightPx = (totalHeight * 0.5).toInt()

            val builder = CustomTabsIntent.Builder(customTabsSession)
            // Partial Custom Tabs の設定
            builder.setInitialActivityHeightPx(heightPx, CustomTabsIntent.ACTIVITY_HEIGHT_ADJUSTABLE)
            builder.setToolbarCornerRadiusDp(16)
            builder.setShowTitle(true)
            // 背景のAI掲示板を操作可能にする設定
            builder.setBackgroundInteractionEnabled(true)

            val customTabsIntent = builder.build()
            customTabsIntent.launchUrl(this, Uri.parse(url))
        } catch (e: Exception) {
            Log.e(TAG, "Error launching custom tab", e)
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        GoogleMobileAdsPlugin.unregisterNativeAdFactory(flutterEngine, "newsNativeFactory")
        GoogleMobileAdsPlugin.unregisterNativeAdFactory(flutterEngine, "threadNativeFactory")
        super.cleanUpFlutterEngine(flutterEngine)
    }
}
