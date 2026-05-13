# PDFree — Project Structure

```
pdfree/
├── index.html          ← Только разметка. Никакого JS или inline CSS.
│
├── css/
│   ├── variables.css   ← Все CSS переменные (цвета, шрифты, отступы)
│   │                     Меняешь цвет сайта — меняешь только здесь
│   ├── animations.css  ← Все @keyframes в одном месте
│   ├── layout.css      ← Страничная раскладка: nav, hero, grid, footer
│   └── components.css  ← Переиспользуемые компоненты: карточки, кнопки, дропзона
│
└── js/
    ├── config.js       ← Константы и определения инструментов
    │                     Добавить новый инструмент = добавить запись здесь
    ├── utils.js        ← Чистые helper-функции без побочных эффектов
    │                     esc(), fmtSize(), id(), show(), hide(), setText()
    ├── worker.js       ← Web Worker для тяжёлых PDF операций
    │                     Отдельный файл — виден в DevTools, легко дебажить
    ├── ui.js           ← DOM-манипуляции: toast, прогресс, переключение секций
    ├── files.js        ← Управление файлами: добавить, удалить, drag-to-reorder
    ├── processor.js    ← Бизнес-логика обработки PDF через Worker
    │                   (логика доната перенесена в app.js)
    └── app.js          ← Точка входа: роутинг, события, склейка модулей
```

## Как добавить новый инструмент

1. Добавь запись в `js/config.js` в объект `TOOLS`
2. Добавь карточку в `index.html` с `data-tool="имя"`
3. Реализуй обработчик в `js/worker.js` (`case 'имя': ...`)
4. Установи `implemented: true` в `config.js`

## Запуск

Нужен локальный сервер (из-за ES modules):
```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve .
```

Затем открой: http://localhost:8080

## Деплой на Vercel

1. Загрузи всю папку `pdfree/` на Vercel
2. Vercel автоматически определит статический сайт
3. Не нужен никакой build step — всё работает "из коробки"

## Замени Ko-fi ссылку

В файле `js/config.js`:
```js
export const DONATE_URL = 'https://ko-fi.com/YOUR_USERNAME';
```

## License

PDFree is free software released under the **GNU Affero General Public License v3**.  
See the [LICENSE](LICENSE) file for details.

Third-party runtime dependencies: pdf-lib (MIT), JSZip (MIT), pdf.js (Apache 2.0).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture notes and how to add new tools.
