const PRESET_QUIZZES = [
  {
    id: 'web-dev',
    title: '🌐 Web Development & Tech Trivia',
    description: 'Test your knowledge on HTML, CSS, JavaScript, and computer science.',
    questions: [
      {
        id: 1,
        text: 'What does CSS stand for?',
        type: 'quiz',
        options: [
          'Cascading Style Sheets',
          'Computer Style Systems',
          'Creative Styling Sheet',
          'Colorful Sheet Styles'
        ],
        correctAnswer: 'Cascading Style Sheets',
        time: 20,
        explanation: 'CSS (Cascading Style Sheets) describes how HTML elements are to be displayed.'
      },
      {
        id: 2,
        text: 'Which HTML element is used to insert JavaScript code?',
        type: 'quiz',
        options: ['<script>', '<javascript>', '<js>', '<code>'],
        correctAnswer: '<script>',
        time: 20,
        explanation: 'The <script> tag is used to embed or reference client-side scripts.'
      },
      {
        id: 3,
        text: 'True or False: In JavaScript, "typeof null" evaluates to "object".',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15,
        explanation: 'In JavaScript, typeof null returning "object" is a historic bug in JS dating back to 1995.'
      },
      {
        id: 4,
        text: 'Which HTTP status code signifies "Not Found"?',
        type: 'quiz',
        options: ['200', '403', '404', '500'],
        correctAnswer: '404',
        time: 20,
        explanation: 'HTTP 404 Not Found indicates that the server cannot find the requested resource.'
      },
      {
        id: 5,
        text: 'What is the standard port number for HTTPS traffic?',
        type: 'quiz',
        options: ['80', '443', '8080', '22'],
        correctAnswer: '443',
        time: 20,
        explanation: 'Port 443 is the standard port for HTTPS encrypted web traffic.'
      }
    ]
  },
  {
    id: 'science',
    title: '🔬 Science & Cosmos',
    description: 'Explore the mysteries of astronomy, biology, physics, and nature.',
    questions: [
      {
        id: 1,
        text: 'What is the closest planet to the Sun in our solar system?',
        type: 'quiz',
        options: ['Venus', 'Mercury', 'Mars', 'Earth'],
        correctAnswer: 'Mercury',
        time: 20,
        explanation: 'Mercury is the smallest and closest planet to the Sun.'
      },
      {
        id: 2,
        text: 'What is the chemical symbol for Gold?',
        type: 'quiz',
        options: ['Ag', 'Au', 'Fe', 'Gd'],
        correctAnswer: 'Au',
        time: 20,
        explanation: 'Au comes from the Latin word for gold, "aurum".'
      },
      {
        id: 3,
        text: 'True or False: Sound travels faster in water than in air.',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15,
        explanation: 'Sound travels about 4.3 times faster in water than in air because water is denser.'
      },
      {
        id: 4,
        text: 'Which gas makes up roughly 78% of Earth\'s atmosphere?',
        type: 'quiz',
        options: ['Oxygen', 'Carbon Dioxide', 'Nitrogen', 'Argon'],
        correctAnswer: 'Nitrogen',
        time: 20,
        explanation: 'Nitrogen makes up approximately 78% of Earth\'s atmosphere, followed by oxygen at 21%.'
      },
      {
        id: 5,
        text: 'How many bones are in the adult human skeleton?',
        type: 'quiz',
        options: ['186', '206', '226', '256'],
        correctAnswer: '206',
        time: 20,
        explanation: 'An adult human body has 206 bones, while babies are born with about 270 bones.'
      }
    ]
  },
  {
    id: 'geography',
    title: '🌍 World Geography & Wonders',
    description: 'Test your knowledge on countries, capitals, continents, and famous landmarks.',
    questions: [
      {
        id: 1,
        text: 'What is the capital city of Japan?',
        type: 'quiz',
        options: ['Kyoto', 'Osaka', 'Tokyo', 'Yokohama'],
        correctAnswer: 'Tokyo',
        time: 20,
        explanation: 'Tokyo has been the capital of Japan since 1868.'
      },
      {
        id: 2,
        text: 'What is the longest river in the world?',
        type: 'quiz',
        options: ['Amazon River', 'Nile River', 'Yangtze River', 'Mississippi River'],
        correctAnswer: 'Nile River',
        time: 20,
        explanation: 'The Nile River in Africa stretches approximately 6,650 kilometers (4,132 miles).'
      },
      {
        id: 3,
        text: 'True or False: Australia is both a continent and a sovereign country.',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'True',
        time: 15,
        explanation: 'Australia is the world\'s smallest continent and the 6th largest country by total area.'
      },
      {
        id: 4,
        text: 'In which South American country is the ancient citadel Machu Picchu located?',
        type: 'quiz',
        options: ['Brazil', 'Chile', 'Peru', 'Colombia'],
        correctAnswer: 'Peru',
        time: 20,
        explanation: 'Machu Picchu is a 15th-century Inca citadel located in the Cusco Region of Peru.'
      },
      {
        id: 5,
        text: 'What is the largest ocean on planet Earth?',
        type: 'quiz',
        options: ['Atlantic Ocean', 'Indian Ocean', 'Pacific Ocean', 'Arctic Ocean'],
        correctAnswer: 'Pacific Ocean',
        time: 20,
        explanation: 'The Pacific Ocean covers more than 30% of Earth\'s surface, larger than all landmass combined.'
      }
    ]
  },
  {
    id: 'general',
    title: '💡 General Knowledge & Pop Culture',
    description: 'Fun trivia covering art, cinema, nature, and everyday curiosities.',
    questions: [
      {
        id: 1,
        text: 'Who painted the famous masterpiece "Mona Lisa"?',
        type: 'quiz',
        options: ['Vincent van Gogh', 'Leonardo da Vinci', 'Pablo Picasso', 'Michelangelo'],
        correctAnswer: 'Leonardo da Vinci',
        time: 20,
        explanation: 'Leonardo da Vinci painted the Mona Lisa in Florence during the Italian Renaissance.'
      },
      {
        id: 2,
        text: 'How many distinct colors are in a standard visible rainbow?',
        type: 'quiz',
        options: ['5', '6', '7', '8'],
        correctAnswer: '7',
        time: 15,
        explanation: 'The 7 colors are Red, Orange, Yellow, Green, Blue, Indigo, and Violet (ROYGBIV).'
      },
      {
        id: 3,
        text: 'True or False: Lightning never strikes the same place twice.',
        type: 'truefalse',
        options: ['True', 'False'],
        correctAnswer: 'False',
        time: 15,
        explanation: 'Lightning frequently strikes the exact same place twice; the Empire State Building is struck ~25 times a year!'
      },
      {
        id: 4,
        text: 'What is the hardest naturally occurring mineral on Earth?',
        type: 'quiz',
        options: ['Gold', 'Quartz', 'Diamond', 'Titanium'],
        correctAnswer: 'Diamond',
        time: 20,
        explanation: 'Diamond is 10 on the Mohs scale of hardness, making it the hardest natural mineral.'
      },
      {
        id: 5,
        text: 'In the game of chess, which piece can move only diagonally?',
        type: 'quiz',
        options: ['Rook', 'Knight', 'Bishop', 'Queen'],
        correctAnswer: 'Bishop',
        time: 20,
        explanation: 'Bishops can move any number of vacant squares diagonally.'
      }
    ]
  }
];

module.exports = { PRESET_QUIZZES };
