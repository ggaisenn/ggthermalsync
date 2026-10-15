FROM nginx:1.27-alpine

COPY dashboard/index.html /usr/share/nginx/html/index.html
COPY dashboard/css /usr/share/nginx/html/css
COPY dashboard/js /usr/share/nginx/html/js
COPY dashboard/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_FILTER="^(BACKEND_HTTP_PORT|SIMULATION_PROXY_TOKEN)$"
RUN sed -i 's#data-telemetry-backend-origin="http://localhost:8080"#data-telemetry-backend-origin="same-origin"#' /usr/share/nginx/html/index.html

EXPOSE 80
