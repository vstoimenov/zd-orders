#!/usr/bin/env bash
# Installs WordPress + WooCommerce in the compose env, a product, payment methods, the Ordyx shipping methods and the local key.
set -euo pipefail
cd "$(dirname "$0")"
export DOCKER_CONFIG=${DOCKER_CONFIG:-/tmp/dockercfg}
COMPOSE=${COMPOSE:-docker-compose}
wp() { $COMPOSE exec -T cli wp "$@"; }

for i in $(seq 1 30); do wp db check >/dev/null 2>&1 && break; sleep 2; done
if ! wp core is-installed >/dev/null 2>&1; then
  wp core install --url=http://localhost:8080 --title="Тест магазин" --admin_user=admin --admin_password=admin-local-1 --admin_email=admin@example.com --skip-email
fi
wp plugin install woocommerce --activate >/dev/null
wp plugin activate ordyx
wp rewrite structure '/%postname%/' --hard
wp option update woocommerce_currency EUR
wp option update woocommerce_default_country BG
wp option update woocommerce_store_city "София"
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_cod_settings '{"enabled":"yes","title":"Наложен платеж","instructions":""}' --format=json
wp option update woocommerce_cheque_settings '{"enabled":"yes","title":"Карта (тест)","instructions":""}' --format=json
wp option update woocommerce_coming_soon no
wp option update ordyx_key "ordyx_live_LOCALLOCAL_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
wp option update ordyx_mode checkout

if [ "$(wp wc product list --user=admin --format=count)" = "0" ]; then
  wp wc product create --user=admin --name="Тениска" --type=simple --regular_price=29.90 --sku=T-M-B >/dev/null
  wp wc product create --user=admin --name="Книга" --type=simple --regular_price=12.90 --sku=BOOK >/dev/null
fi
Z=$(wp wc shipping_zone list --user=admin --fields=id,name --format=csv | awk -F, '$2=="България"{print $1}')
if [ -z "$Z" ]; then Z=$(wp wc shipping_zone create --user=admin --name="България" --porcelain); fi
wp eval "\$z = WC_Shipping_Zones::get_zone($Z); \$z->set_locations([['code' => 'BG', 'type' => 'country']]); \$z->save();"
if [ "$(wp wc shipping_zone_method list "$Z" --user=admin --format=count)" = "0" ]; then
  for spec in "econt_office|Еконт – офис или автомат|4.5" "econt_address|Еконт – до адрес|6.9" "speedy_office|Спиди – офис или автомат|4.9" "speedy_address|Спиди – до адрес|6.5" "boxnow_locker|BOX NOW – автомат|3.9"; do
    IFS='|' read -r type title cost <<< "$spec"
    wp wc shipping_zone_method create "$Z" --user=admin --method_id=ordyx --settings="{\"ordyx_type\":\"$type\",\"title\":\"$title\",\"cost\":\"$cost\",\"free_over\":\"50\"}" >/dev/null
  done
  wp wc shipping_zone_method create "$Z" --user=admin --method_id=flat_rate --settings='{"title":"Друг куриер (flat rate)","cost":"5"}' >/dev/null
fi
# a classic (shortcode) checkout page next to the block one, to test both
if ! wp post list --post_type=page --name=klasicheski-chekaut --format=count | grep -q 1; then
  wp post create --post_type=page --post_status=publish --post_title="Класически чекаут" --post_name=klasicheski-chekaut --post_content='[woocommerce_checkout]' >/dev/null
fi
echo "ready: http://localhost:8080 (admin / admin-local-1) · block checkout page id $(wp option get woocommerce_checkout_page_id) · classic page id $(wp post list --post_type=page --name=klasicheski-chekaut --field=ID)"
