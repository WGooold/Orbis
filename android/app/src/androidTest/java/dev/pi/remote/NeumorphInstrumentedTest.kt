package dev.pi.remote

import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

class NeumorphInstrumentedTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun updatingCardsWithoutChangingGeometryKeepsGraphicsMemoryBounded() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
        val revision = mutableIntStateOf(0)
        compose.setContent {
            MaterialTheme {
                Column {
                    repeat(6) {
                        NeumorphSurface(
                            modifier = Modifier.width(280.dp).height(64.dp),
                            style = NeumorphStyle.Pressed,
                            // Forces the real surface to recompose, while its geometry and pixels
                            // remain the same. Previously each update rebuilt the blurred paths.
                            enabled = revision.intValue % 2 == 0,
                        ) {
                            Box(Modifier.height(64.dp))
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
        val baseline = graphicsBytes()
        // This generous margin permits renderer bookkeeping; the original implementation grew
        // hundreds of MiB for these six cards. No private Path identity or cache field is asserted.
        val allowance = 64L * 1024 * 1024
        repeat(3) {
            repeat(15) {
                compose.runOnIdle { revision.intValue += 1 }
                compose.waitForIdle()
            }
            val current = graphicsBytes()
            assertTrue(
                "Redrawing fixed-size cards grew graphics resources by ${(current - baseline) / 1024 / 1024} MiB",
                current <= baseline + allowance,
            )
        }
    }

    private fun graphicsBytes(): Long {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val appId = instrumentation.targetContext.packageName
        val descriptor = instrumentation.uiAutomation.executeShellCommand("dumpsys gfxinfo $appId")
        val report = ParcelFileDescriptor.AutoCloseInputStream(descriptor).bufferedReader().use { it.readText() }
        val match = Regex("Total GPU memory usage:\\s*(\\d+) bytes").find(report)
        assumeTrue("This renderer does not report its graphics resource allocation", match != null)
        return requireNotNull(match).groupValues[1].toLong()
    }
}
