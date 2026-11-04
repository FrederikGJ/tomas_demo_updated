# Use the official Node.js image as the base image
FROM node:24-alpine

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code (index.ts + the GUI in public/)
COPY . .

# Add wait-for-it.sh script
COPY wait-for-it.sh /wait-for-it.sh
RUN chmod +x /wait-for-it.sh

# Expose the port the app (GUI + API) runs on
EXPOSE 3004

# Run the application with the wait-for-it.sh script, set the timeout to 60 seconds.
# The service also retries the RabbitMQ connection by itself if RabbitMQ is not ready yet.
CMD ["sh", "/wait-for-it.sh", "rabbitmq:5672", "-t", "60", "--", "npm", "start"]
