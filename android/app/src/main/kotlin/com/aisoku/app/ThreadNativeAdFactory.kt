package com.aisoku.app

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import com.google.android.gms.ads.nativead.NativeAd
import com.google.android.gms.ads.nativead.NativeAdView
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugins.googlemobileads.NativeAdFactory

class ThreadNativeAdFactory(private val context: Context, private val channel: MethodChannel) : NativeAdFactory {
    override fun createNativeAd(ad: NativeAd, customOptions: MutableMap<String, Any>?): NativeAdView {
        val view = NativeAdView(context).apply { setBackgroundColor(Color.WHITE) }
        val id = customOptions?.get("adInstanceId")
        if (ad.mediaContent?.hasVideoContent() == true) {
            // thread_native must be configured as image-only in AdMob. A video
            // must never be shown without its required MediaView.
            view.setNativeAd(ad)
            Handler(Looper.getMainLooper()).post { channel.invokeMethod("unsupportedVideo", mapOf("adInstanceId" to id)) }
            return view
        }
        val width = ((customOptions?.get("width") as? Number)?.toInt() ?: 320)
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(context.dp(8), context.dp(6), context.dp(8), context.dp(6))
        }
        val header = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, context.dp(32), 0) }
        val badge = context.assetText("【広告】", 11f).apply { minHeight = context.dp(15); minWidth = context.dp(15) }
        val icon = context.icon(ad.icon?.drawable)
        val headline = context.assetText(ad.headline, 13f, 25)
        header.addView(badge)
        header.addView(icon, LinearLayout.LayoutParams(context.dp(28), context.dp(28)))
        header.addView(headline, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        column.addView(header)
        val advertiser = context.assetText(ad.advertiser, 11f, 25)
        val body = context.assetText(ad.body, 12f, 90)
        val cta = context.assetText(ad.callToAction, 12f, 15).apply { setTextColor(Color.rgb(0, 80, 170)) }
        column.addView(advertiser); column.addView(body); column.addView(cta)
        view.addView(column, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT))
        view.headlineView = headline; view.iconView = icon; view.advertiserView = advertiser; view.bodyView = body; view.callToActionView = cta
        view.addChoices(context)
        view.setNativeAd(ad)
        column.measureAtWidth(context.dp(width))
        val height = column.measuredHeight / context.resources.displayMetrics.density
        Handler(Looper.getMainLooper()).post { channel.invokeMethod("measuredHeight", mapOf("adInstanceId" to id, "height" to height.toDouble())) }
        var measuredWidth = context.dp(width)
        view.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
            val currentWidth = right - left
            if (currentWidth > 0 && currentWidth != measuredWidth) {
                measuredWidth = currentWidth
                column.measureAtWidth(currentWidth)
                val updatedHeight = column.measuredHeight / context.resources.displayMetrics.density
                Handler(Looper.getMainLooper()).post { channel.invokeMethod("measuredHeight", mapOf("adInstanceId" to id, "height" to updatedHeight.toDouble())) }
            }
        }
        return view
    }
}
