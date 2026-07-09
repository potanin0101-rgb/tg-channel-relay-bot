# Telegram Channel Relay Bot

Бот берёт новые посты из `source`-канала и публикует их в один или несколько `target`-каналов в лайв-режиме.

Для каждого маршрута `source -> target` можно задать свою замену текста:

- менять телефон
- менять ссылку
- менять любой фрагмент текста
- пропускать только нужные марки, модели или темы

## Что умеет

- один source -> много target-каналов
- отдельная замена текста на каждом маршруте
- include / exclude фильтры по ключевым словам
- включение и выключение маршрутов
- меню в личке бота
- текстовые посты
- одиночные медиа
- альбомы
- JSON-хранилище без базы данных

## Ограничения

- бот должен быть администратором во всех каналах
- после замены текста Telegram-форматирование может не сохраниться, если длина текста изменилась
- кнопки под исходными постами не копируются
- экзотические типы сообщений могут уйти через `copyMessage` только без замены текста

## Запуск

```bash
cd /Users/ivanpotanin/Documents/New\ project/tg-channel-relay-bot
cp .env.example .env.local
node src/bot.mjs
```

Или:

```bash
npm start
```

## Настройка

### 1. Создайте бота

Через `@BotFather` получите токен и вставьте его в `.env.local`.

Бот понимает оба имени переменной:

- `BOT_TOKEN`
- `TELEGRAM_BOT_TOKEN`

### 2. Добавьте бота в каналы

Во все исходные и целевые каналы бот должен быть добавлен как администратор.

### 3. Зарегистрируйте каналы

В исходном канале опубликуйте:

```text
/register_source main
```

В целевом канале:

```text
/register_target promo-1
```

Во втором целевом:

```text
/register_target promo-2
```

### 4. Создайте маршруты

В личке с ботом:

```text
/route_add main promo-1
/route_add main promo-2
```

### 5. Задайте замены

Для первого канала:

```text
/route_replace main promo-1 +79990000000 => +78880000001
```

Для второго:

```text
/route_replace main promo-2 +79990000000 => +78880000002
```

Теперь каждый новый пост из `main` будет уходить в оба канала с разными номерами.

### 6. Задайте фильтры по бренду или теме

Если есть отдельный канал только под BMW:

```text
/register_target bmw-only
/route_add main bmw-only
/route_include main bmw-only bmw,x5,x6,m3,m5
```

Если нужно отсечь конкурентов:

```text
/route_exclude main bmw-only audi,mercedes,toyota
```

Теперь в `bmw-only` попадут только посты, где в тексте или подписи есть слова из include-списка и нет слов из exclude-списка.

## Меню

В личке отправьте:

```text
/start
```

Меню покажет:

- статус
- каналы
- маршруты
- помощь

Из раздела маршрутов можно:

- включать и выключать маршрут
- удалять маршрут
- задавать замену через кнопку
- задавать include / exclude фильтры через кнопки

## Команды в личке

```text
/start
/menu
/help
/status
/route_add source_alias target_alias
/route_remove source_alias target_alias
/route_replace source_alias target_alias старый текст => новый текст
/route_clear source_alias target_alias
/route_include source_alias target_alias bmw,x5,m3
/route_exclude source_alias target_alias audi,mercedes
/route_filters_clear source_alias target_alias
```

## Данные

Конфиг хранится в:

`data/config.json`

Там лежат:

- админы
- каналы
- маршруты
- последний `update_id`

## Деплой на BotHost

Проект подготовлен под тот же сценарий, что использовали для калькулятора:

1. Загрузить репозиторий в GitHub.
2. В `BotHost` создать нового бота из Git-репозитория.
3. Включить кастомный `Dockerfile`, если `BotHost` не подхватывает его автоматически.
4. Указать `BOT_TOKEN` в переменных окружения или загрузить `.env`.
5. Команда запуска: `npm start`.

Файлы для деплоя:

- [Dockerfile](/Users/ivanpotanin/Documents/New%20project/tg-channel-relay-bot/Dockerfile)
- [index.js](/Users/ivanpotanin/Documents/New%20project/tg-channel-relay-bot/index.js)

## Рекомендация

Если нужно не только менять номер, а ещё выбирать разные тексты, подписи, UTM-ссылки, бренды и режимы публикации для разных каналов, следующий шаг логично сделать таким:

- шаблоны подписи на маршрут
- фильтры по хэштегам
- обязательные и необязательные фильтры с логикой `any/all`
- отложенная публикация
- лог отправок
