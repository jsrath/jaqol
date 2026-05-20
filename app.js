const width = 1145;
const height = 641;

const projection = d3
  .geoAlbersUsa()
  .translate([width / 2, height / 2])
  .scale(1425);

const path = d3.geoPath().projection(projection);

const div = d3
  .select('body')
  .append('div')
  .attr('class', 'tooltip')
  .style('opacity', 0);

const svg = d3
  .select('#map')
  .append('svg')
  .attr('width', width)
  .attr('height', height)
  .attr('viewBox', `0 0 ${width} ${height}`)
  .attr('preserveAspectRatio', 'xMidYMid meet');

function showLoadError(message) {
  d3.select('.loader').remove();
  d3.select('#map')
    .append('p')
    .attr('class', 'load-error')
    .text(message);
}

function renderCities(payload) {
  const cities = payload.data.filter(city => city.qualityOfLife !== null);
  const jobNumbers = cities.map(city => city.jobs);
  const qualityScores = cities.map(city => city.qualityOfLife);

  const circleScale = d3
    .scalePow()
    .exponent(0.5)
    .domain([0, d3.max(jobNumbers)])
    .range([0, 30]);

  const color = d3
    .scaleLinear()
    .domain([d3.min(qualityScores), d3.mean(qualityScores), d3.max(qualityScores)])
    .range(['#d64545', '#f0d045', '#3cb371']);

  svg
    .selectAll('.shapes')
    .data(cities)
    .enter()
    .append(() => document.createElementNS('http://www.w3.org/2000/svg', 'circle'))
    .attr('class', 'shapes');

  svg
    .selectAll('circle')
    .attr('class', 'circle')
    .attr('cx', d => projection([d.lon, d.lat])[0])
    .attr('cy', d => projection([d.lon, d.lat])[1])
    .attr('r', d => circleScale(d.jobs))
    .attr('fill', d => color(d.qualityOfLife))
    .on('mouseover', (d, index, element) => {
      div
        .transition()
        .duration(200)
        .style('opacity', 0.9);

      div
        .html(
          `<p id="city">${d.city}, ${d.state}</p>
           <p>${d.jobs.toLocaleString()} frontend jobs</p>
           <p>QoL index: ${d.qualityOfLife.toFixed(1)}</p>`,
        )
        .style('left', d3.event.pageX + 'px')
        .style('top', d3.event.pageY - 28 + 'px')
        .style('color', d3.select(element[index]).attr('fill'));
    })
    .on('mouseout', () => {
      div
        .transition()
        .duration(100)
        .style('opacity', 0);
    });

  d3.select('.loader').remove();
}

d3.json('us-states.json', (error, states) => {
  if (error) {
    showLoadError('Unable to load map data');
    console.error(error);
    return;
  }

  svg
    .selectAll('path')
    .data(states.features)
    .enter()
    .append('path')
    .attr('d', path)
    .attr('class', 'states');

  d3.json('/api/cities', (cityError, data) => {
    if (cityError || !data?.data?.length) {
      showLoadError('Unable to load live city data');
      console.error(cityError);
      return;
    }

    renderCities(data);
  });
});
