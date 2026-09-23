package dev.pi.remote

/**
 * Node 侧权威实现（`packages/e2e`）用固定密钥生成的交叉验证向量。
 * 生成脚本：`scripts/e2e-vectors.mjs`。固定熵约定见该脚本头注释。
 * 两端任何一侧改动密码学行为，这些测试必挂。
 */
object E2eVectors {
    /** RFC 7748 §5.2 Alice 公钥（= host 长期公钥）。 */
    const val HOST_PUB = "hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo"
    /** RFC 7748 §5.2 Bob 公钥（= 设备长期公钥）。 */
    const val DEVICE_PUB = "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08"

    const val PSK_ROOT = "Xc5yaEsPIReHbncWPXU1GrW_YpUGNcpX5p1Zb-9dEwE"
    const val CONFIRM_KEY = "-G7rO7iQuhdH7rmm3agDYiIR8XmedYKDmimm7DAlHEE"

    /** 32 字节全 0x22 的 base64url。 */
    const val NONCE_D = "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI"
    /** 32 字节全 0x33 的 base64url。 */
    const val NONCE_H = "MzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM"

    const val MAC_D = "ywudy3_oqEafVQ1k7OtqWzUvrOG9ETuIwgiSAE0Em3c"
    const val MAC_H = "mhBLskBz0yVpG0VOkZBT9OPYN-VBFtIe8n5lLbbcBOw"

    /** 32 字节全 0x44 的 X25519 私钥对应公钥。 */
    const val E_PUB_D = "_y7kVgHsG2cxDHeQQEWFrmlzMe7hwfjPJBlzHB__Pms"
    /** 32 字节全 0x55 的 X25519 私钥对应公钥。 */
    const val E_PUB_H = "OKtmS9hvd9fma92a4HkpE6lP2LM6EmACfktGwfSITGc"

    const val K_H2D = "-Kwx43HwDDM6EXM8p80AX_mmYwMamhFMm089UZM1rWI"
    const val K_D2H = "a2vzVQwGvTKpwawGTEw6-qEO1HXnUC5P9uTSDTd6WgY"
    const val HS_MAC_H = "phYx4BZpBVq0X8qN-_qZ2tMZLobFaYILeNZfd0EDbVA"
    const val HS_MAC_D = "Lkw-uItTWBebh0ONoovU7ypS7-2EjpS3Lj5XmOk9TBM"

    /** data 帧密文：hdr = {k:data, room:host-1, from:device-1, to:host-1, ch:ctl, n:1}，payload = {"type":"device.ready"}。 */
    const val DATA_CT_N1 = "D9kX4K5xUPHFcmADHFlly_cs6SipR2RIN0tzKFh3Q3JA0mvUw7T8"
    /** 同上但 n:2，payload = "hello world"。 */
    const val DATA_CT_N2 = "Vnw5ZWj0XBmcrEZHu4ObE4FabcMXjWIESMkB"
}
