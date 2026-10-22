<?php
/**
 * Plugin Name: Ordyx за WooCommerce
 * Plugin URI: https://ordyx.eu
 * Description: Избор на офис или автомат на Еконт, Спиди и BOX NOW в чекаута; поръчките влизат в Ordyx; товарителницата и проследяването се връщат в WooCommerce.
 * Version: 1.0.0
 * Author: Ordyx
 * Author URI: https://ordyx.eu
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * WC requires at least: 8.0
 * Text Domain: ordyx
 */

if (!defined('ABSPATH')) exit;

define('ORDYX_VERSION', '1.0.0');
define('ORDYX_API_VERSION', 1);
define('ORDYX_FILE', __FILE__);
define('ORDYX_DIR', plugin_dir_path(__FILE__));
define('ORDYX_URL', plugin_dir_url(__FILE__));
if (!defined('ORDYX_API_URL')) define('ORDYX_API_URL', 'https://app.ordyx.eu');

require_once ORDYX_DIR . 'includes/class-ordyx-api.php';
require_once ORDYX_DIR . 'includes/class-ordyx-settings.php';
require_once ORDYX_DIR . 'includes/class-ordyx-shipping.php';
require_once ORDYX_DIR . 'includes/class-ordyx-checkout.php';
require_once ORDYX_DIR . 'includes/class-ordyx-blocks.php';
require_once ORDYX_DIR . 'includes/class-ordyx-sender.php';
require_once ORDYX_DIR . 'includes/class-ordyx-rest.php';
require_once ORDYX_DIR . 'includes/class-ordyx-updater.php';

// HPOS (custom order tables) and the block cart/checkout are supported
add_action('before_woocommerce_init', function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

add_action('plugins_loaded', function () {
    if (!class_exists('WooCommerce')) {
        add_action('admin_notices', function () {
            echo '<div class="notice notice-error"><p><b>Ordyx</b>: инсталирайте и включете WooCommerce, за да работи плъгинът.</p></div>';
        });
        return;
    }
    Ordyx_Settings::init();
    Ordyx_Shipping::init();
    Ordyx_Checkout::init();
    Ordyx_Blocks::init();
    Ordyx_Sender::init();
    Ordyx_Rest::init();
    Ordyx_Updater::init();
});

register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook('ordyx_retry');
});
